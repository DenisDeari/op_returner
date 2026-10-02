// backend/server.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./src/config');
const hygiene = require('./src/http_hygiene');
const { db, initializeDatabase } = require('./src/database');
const { initializeWallet } = require('./src/wallet');
const requestQueue = require('./src/queue');
const { cleanupOldRequests } = require('./src/cleanup');
const { runReconciliation } = require('./src/reconcile');
const { checkPendingConfirmations } = require('./src/confirm_watch');
const eventLog = require('./src/event_log');
const wall = require('./src/wall');
const wallHtml = require('./src/wall_html');
const messagePage = require('./src/message_page');
const sitemap = require('./src/sitemap');
const counters = require('./src/counters');

// Start capturing warnings and errors before anything else runs, so the admin panel's
// log view includes startup problems too.
eventLog.install();
const createApiRouter = require('./src/routes/api');
const createWebhookRouter = require('./src/routes/webhook');
const createAdminRouter = require('./src/routes/admin');
const createWalletRouter = require('./src/routes/wallet');
const createInternalRouter = require('./src/routes/internal');

// --- Initialization ---
// The HTTP listener and the scheduled jobs both start from this callback, once the
// schema and wallet_state are guaranteed to exist. Binding the port earlier would let a
// request arrive before wallet_state is seeded, which fails address derivation.
initializeDatabase(() => {
    startServer();
    startScheduledJobs();
});
const rootNode = initializeWallet();
const app = express();

// Nothing gains from announcing the framework, and it is one line.
app.disable('x-powered-by');

// --- Middleware ---
// The raw bytes are kept alongside the parsed body: phoenixd signs the exact body it
// sends (routes/webhook.js, POST /lightning), and re-serialising the parsed JSON would not
// reproduce it byte for byte.
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; },
}));

// HTTP hygiene: force TLS, keep /admin out of search results, and decide what may be
// cached. The logic lives in src/http_hygiene.js so that it can be tested — requiring this
// file opens the production database and binds a port, so nothing declared here could be.
app.use(hygiene.forceHttps);
app.use('/admin', hygiene.noIndexAdmin);
app.use(hygiene.markCacheable);

// --- Serve Frontend ---
const FRONTEND_DIR = path.join(__dirname, '../frontend');
const INDEX_PATH = path.join(FRONTEND_DIR, 'index.html');

// The homepage is rendered, not sent as a file, so the public wall is in the HTML itself.
// See src/wall_html.js for why. Three things about the placement of this block matter:
//
//   - It is registered BEFORE express.static. Static would otherwise answer `/` from its
//     directory-index behaviour and `/index.html` from the file, and both would serve the
//     unrendered template — the second one silently, at a URL a crawler can still reach.
//   - `index: false` turns off that directory-index behaviour for good, so there is
//     exactly one code path that can produce the homepage.
//   - Both URLs are handled here, and /index.html 301s to `/`. The canonical tag already
//     says which one counts; a redirect means the duplicate never has to be discounted.
const INDEX_TEMPLATE = { html: null, mtimeMs: 0 };

/**
 * The homepage template, re-read only when the file on disk changes.
 *
 * A `statSync` per homepage hit is cheap (the OS caches the inode) and keeps an edit to
 * index.html live without a restart, which is how this file has always behaved when it was
 * served statically. Returns null if the file cannot be read at all.
 */
function readIndexTemplate() {
    try {
        const { mtimeMs } = fs.statSync(INDEX_PATH);
        if (!INDEX_TEMPLATE.html || mtimeMs !== INDEX_TEMPLATE.mtimeMs) {
            INDEX_TEMPLATE.html = fs.readFileSync(INDEX_PATH, 'utf8');
            INDEX_TEMPLATE.mtimeMs = mtimeMs;
        }
        return INDEX_TEMPLATE.html;
    } catch (e) {
        console.error(`[Home] Could not read index.html: ${e.message}`);
        return null;
    }
}

/**
 * Serves the homepage with the wall already in it.
 *
 * EVERY failure path here still serves the page. The homepage is the composer and the
 * composer is how the service takes money, so a database that will not answer must cost
 * the visitor the wall, never the ability to publish. The wall read is the same cached
 * call the /api/wall endpoint makes (wall.js, CACHE_MS), so this adds no query per visit.
 */
async function serveHome(req, res) {
    const template = readIndexTemplate();
    if (template === null) return res.status(500).send('Homepage unavailable.');

    // Counts visits so the quote-to-visit ratio is answerable. In-memory, aggregate,
    // no identifier of any kind — see src/counters.js.
    counters.bump('home_view');

    let html = template;
    try {
        const { messages } = await wall.listPublicMessages(db);
        html = wallHtml.injectWall(template, messages);
    } catch (e) {
        console.warn(`[Home] Wall render skipped: ${e.message}`);
    }

    // Never long-cached, for the same reason index.html never was: this document carries
    // the `?v=N` that versions every other asset.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', hygiene.CACHE_REVALIDATE);
    return res.send(html);
}

app.get('/', serveHome);
app.get('/index.html', (req, res) => res.redirect(301, '/'));

// The explainer, at an extension-less URL. Registered here for the same reason the
// homepage is: express.static would otherwise serve it only at /what-is-op-return.html,
// and a page reachable at two URLs is a page competing with itself. The .html spelling
// 301s to the canonical one.
const EXPLAINER_PATH = path.join(FRONTEND_DIR, 'what-is-op-return.html');
app.get('/what-is-op-return', (req, res) => {
    res.setHeader('Cache-Control', hygiene.CACHE_REVALIDATE);
    res.sendFile(EXPLAINER_PATH);
});
app.get('/what-is-op-return.html', (req, res) => res.redirect(301, '/what-is-op-return'));

// The landing page for the thing customers actually do here: aim a message at somebody
// else's address. Same shape as the explainer — extension-less URL, the .html spelling
// redirects to it, so the page never competes with itself.
const AIM_PAGE = 'send-a-message-to-a-bitcoin-address';
app.get(`/${AIM_PAGE}`, (req, res) => {
    res.setHeader('Cache-Control', hygiene.CACHE_REVALIDATE);
    res.sendFile(path.join(FRONTEND_DIR, `${AIM_PAGE}.html`));
});
app.get(`/${AIM_PAGE}.html`, (req, res) => res.redirect(301, `/${AIM_PAGE}`));

// One published message, at /m/<txid>.
//
// The template is read the same way the homepage's is, so an edit is live without a
// restart. Everything that decides what the page says lives in src/message_page.js; this
// route only fetches the row and answers the right status code.
//
// EVERY refusal is the same 404 page: unknown txid, malformed txid, hidden by the
// operator, withdrawn by the customer, redacted. wall.findPublicMessage returns null for
// all of them because it runs the wall's own predicate, and the caller must not be able to
// tell them apart — see the comment at the top of message_page.js.
const MESSAGE_TEMPLATE_PATH = path.join(FRONTEND_DIR, 'message.html');
const MESSAGE_TEMPLATE = { html: null, mtimeMs: 0 };

function readMessageTemplate() {
    try {
        const { mtimeMs } = fs.statSync(MESSAGE_TEMPLATE_PATH);
        if (!MESSAGE_TEMPLATE.html || mtimeMs !== MESSAGE_TEMPLATE.mtimeMs) {
            MESSAGE_TEMPLATE.html = fs.readFileSync(MESSAGE_TEMPLATE_PATH, 'utf8');
            MESSAGE_TEMPLATE.mtimeMs = mtimeMs;
        }
        return MESSAGE_TEMPLATE.html;
    } catch (e) {
        console.error(`[Message] Could not read message.html: ${e.message}`);
        return null;
    }
}

app.get('/m/:txid', async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', hygiene.CACHE_REVALIDATE);
    try {
        const row = await wall.findPublicMessage(db, req.params.txid);
        const template = row ? readMessageTemplate() : null;
        if (!row || template === null) {
            return res.status(404).send(messagePage.renderNotFound());
        }
        return res.send(messagePage.renderMessagePage(template, row, config.PUBLIC_BASE_URL));
    } catch (e) {
        // A database that will not answer is not a missing message, and saying "not found"
        // would invite a crawler to drop a page that exists. 503 is the honest answer and
        // the one that gets retried.
        console.warn(`[Message] Lookup failed: ${e.message}`);
        return res.status(503).send(messagePage.renderNotFound());
    }
});

// robots.txt, served from here so the Sitemap line is built from the same
// PUBLIC_BASE_URL as every canonical tag. A hand-written file would be a second place that
// names the host, and the one that fell behind would be the one pointing crawlers at a
// sitemap that no longer exists.
//
// NOTHING IS DISALLOWED, deliberately. /admin is kept out of search results with an
// X-Robots-Tag header instead — http_hygiene.js explains why: robots.txt is public, so a
// Disallow line advertises the path to exactly the scrapers it is meant to hide it from.
//
// Cloudflare may prepend its own content-signals block to this. That is additive and does
// not remove the Sitemap line; if it ever replaces the file outright, the sitemap can be
// submitted directly in Search Console instead.
// Cloudflare's Content Signals Policy preamble, kept VERBATIM.
//
// Until this route existed, /robots.txt was answered by Cloudflare's managed file, which
// carried exactly this text and no directives at all. Serving our own file from the origin
// takes precedence over it, so without this block the reservation of rights under Article 4
// of EU Directive 2019/790 would have silently disappeared the moment the sitemap line was
// added — a legal notice removed as a side effect of an SEO change.
//
// No `Content-Signal:` line is set here, because none was set before: adding one would be
// choosing the operator's policy on AI training and search indexing for them. That choice
// is theirs to make, and this is where it would go when they make it.
const CONTENT_SIGNALS_PREAMBLE = `# As a condition of accessing this website, you agree to abide by the following
# content signals:

# (a)  If a content-signal = yes, you may collect content for the corresponding
#      use.
# (b)  If a content-signal = no, you may not collect content for the
#      corresponding use.
# (c)  If the website operator does not include a content signal for a
#      corresponding use, the website operator neither grants nor restricts
#      permission via content signal with respect to the corresponding use.

# The content signals and their meanings are:

# search:   building a search index and providing search results (e.g., returning
#           hyperlinks and short excerpts from your website's contents). Search does not
#           include providing AI-generated search summaries.
# ai-input: inputting content into one or more AI models (e.g., retrieval
#           augmented generation, grounding, or other real-time taking of content for
#           generative AI search answers).
# ai-train: training or fine-tuning AI models.

# ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS ARE EXPRESS RESERVATIONS OF
# RIGHTS UNDER ARTICLE 4 OF THE EUROPEAN UNION DIRECTIVE 2019/790 ON COPYRIGHT
# AND RELATED RIGHTS IN THE DIGITAL SINGLE MARKET.

`;

app.get('/robots.txt', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', hygiene.CACHE_REVALIDATE);
    return res.send(`${CONTENT_SIGNALS_PREAMBLE}
User-agent: *
Allow: /

Sitemap: ${config.PUBLIC_BASE_URL}/sitemap.xml
`);
});

// The sitemap, generated from the same predicate as the wall.
//
// Not cached beyond revalidation: it is fetched by crawlers minutes or hours apart, and a
// message published in between should not have to wait for a cache to expire to be
// announced. A failure answers 503 rather than an empty sitemap — an empty one tells a
// crawler that every page it knew about is gone.
app.get('/sitemap.xml', async (req, res) => {
    try {
        const rows = await wall.listAllPublicMessages(db);
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', hygiene.CACHE_REVALIDATE);
        return res.send(sitemap.renderSitemap(rows, config.PUBLIC_BASE_URL));
    } catch (e) {
        console.warn(`[Sitemap] Generation failed: ${e.message}`);
        return res.status(503).type('text/plain').send('Sitemap temporarily unavailable.');
    }
});

const STATIC_OPTIONS = { setHeaders: hygiene.staticCacheHeaders };
app.use(express.static(FRONTEND_DIR, { ...STATIC_OPTIONS, index: false }));
app.use('/admin', express.static(path.join(__dirname, '../frontend/admin'), STATIC_OPTIONS));

// --- API Routes ---
const apiRouter = createApiRouter(db, rootNode, config, requestQueue);
const webhookRouter = createWebhookRouter(db, rootNode, config);
const adminRouter = createAdminRouter(db, rootNode, config);
const walletRouter = createWalletRouter(db, rootNode, config);
const internalRouter = createInternalRouter(db, rootNode, config);

app.use('/api', apiRouter);
app.use('/api/webhook', webhookRouter);
// Mounted before the general admin router so /api/admin/wallet/* resolves here.
app.use('/api/admin/wallet', walletRouter);
app.use('/api/admin', adminRouter);
app.use('/api/internal', internalRouter);

// --- Start Server ---
let serverStarted = false;
function startServer() {
    if (serverStarted) return;
    serverStarted = true;
    app.listen(config.PORT, () => {
        console.log(`Server listening on port ${config.PORT}`);
        console.log(`API: http://localhost:${config.PORT}/api`);
        console.log(`Admin: http://localhost:${config.PORT}/admin`);
    });
}

// --- Scheduled Jobs ---
// Called from the initializeDatabase ready callback so no job ever queries a table or
// column that has not been created yet.
let scheduledJobsStarted = false;
function startScheduledJobs() {
    if (scheduledJobsStarted) return;
    scheduledJobsStarted = true;

    const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
    cleanupOldRequests(db); // Run once on startup
    setInterval(() => cleanupOldRequests(db), CLEANUP_INTERVAL_MS);
    console.log(`[Server] Cleanup job scheduled to run every ${CLEANUP_INTERVAL_MS / (1000 * 60 * 60)} hours.`);

    // Reconciliation retries dropped fulfilments, refunds terminal failures, and reports
    // any request still holding customer funds. Runs on startup so a restart immediately
    // picks up whatever was in flight when the process last stopped.
    const RECONCILE_INTERVAL_MS = config.RECONCILE_INTERVAL_MS;
    runReconciliation(db, rootNode, config);
    setInterval(() => runReconciliation(db, rootNode, config), RECONCILE_INTERVAL_MS);
    console.log(`[Server] Reconciliation job scheduled to run every ${RECONCILE_INTERVAL_MS / (1000 * 60)} minutes.`);

    // Website counters, written in one batch per interval rather than per page view.
    // Deliberately last and deliberately quiet: it is the only scheduled job here that no
    // money path depends on, and counters.flush already handles its own failures by
    // deferring the counts to the next pass.
    setInterval(() => {
        counters.flush(db).catch((e) => console.warn(`[Counters] Flush failed: ${e.message}`));
    }, counters.FLUSH_INTERVAL_MS);
    console.log(`[Server] Counter flush scheduled every ${counters.FLUSH_INTERVAL_MS / 1000} seconds.`);

    // Notices when a published OP_RETURN reaches a block. Read-only and Esplora-only —
    // it moves no money and cannot touch the BlockCypher allowance. Unlike reconcile it
    // is NOT run on startup: nothing depends on it being fresh at boot, and a deploy
    // should not fire a burst of provider requests before the service is even serving.
    const CONFIRM_WATCH_INTERVAL_MS = config.CONFIRM_WATCH_INTERVAL_MS;
    setInterval(() => {
        checkPendingConfirmations(db, config).catch((e) =>
            console.warn(`[ConfirmWatch] Pass failed: ${e.message}`));
    }, CONFIRM_WATCH_INTERVAL_MS);
    console.log(`[Server] Confirmation watch scheduled to run every ${CONFIRM_WATCH_INTERVAL_MS / (1000 * 60)} minutes.`);
}