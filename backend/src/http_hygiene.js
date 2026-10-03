// backend/src/http_hygiene.js
//
// The pieces of HTTP hygiene that sit in front of everything else: forcing TLS, keeping
// the admin out of reach of the internet and out of search results, and deciding what may
// be cached.
//
// They live here rather than inline in server.js for one reason: server.js opens the
// production database and binds a port the moment it is required, so nothing in it can be
// tested. This module is side-effect free — the same reason schema.js is.
//
// None of this is a money path. It is in front of one.

const net = require('net');
const path = require('path');

const HSTS_MAX_AGE_SECONDS = 15552000; // 180 days

// A long max-age is only ever safe for a URL that CHANGES when its bytes change. That is
// true of `app.js?v=13` and of the SHA-pinned codec under /vendor/, and false of everything
// else — an unversioned file cached for a week is a file you cannot fix for a week.
const CACHE_VERSIONED = 'public, max-age=604800';         // 7 days
const CACHE_REVALIDATE = 'public, max-age=0, must-revalidate';

/**
 * Redirects plaintext http to https, and announces the policy over https.
 *
 * This page's whole job is to display a Bitcoin address a customer then pays. Over
 * plaintext, anything on the path can rewrite that address — and until 2026-08-12
 * `http://satwire.io/` answered 200 with the full page and no redirect at all.
 *
 * Cloudflare terminates TLS and the tunnel forwards the original scheme in
 * `X-Forwarded-Proto`. Three deliberate choices:
 *
 *   - Redirect ONLY when the header says `http` outright. Absent or unrecognised means we
 *     do not know, and guessing wrong here is a redirect loop that takes the site down.
 *   - GET and HEAD only. A 301 is allowed to drop a request body, and BlockCypher's
 *     unauthenticated webhook POSTs here — losing one loses a customer's payment event.
 *   - HSTS is sent only over https, per the spec, and deliberately without `preload` or
 *     `includeSubDomains`: both are far harder to walk back than they are to turn on.
 */
function forceHttps(req, res, next) {
    const proto = req.headers['x-forwarded-proto'];
    if (proto === 'http') {
        if (req.method === 'GET' || req.method === 'HEAD') {
            return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
        }
        return next();
    }
    if (proto === 'https') {
        res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE_SECONDS}`);
    }
    return next();
}

/**
 * A peer address that can only be the LAN, the VPN, Docker or this machine.
 *
 * Deliberately not lightning.js `isPrivateAddress`, which answers the opposite question
 * ("must I refuse to pay this host?") and so calls anything that is not an IP private. Here
 * private means ALLOWED, so anything unrecognised is not.
 */
function isPrivatePeer(address) {
    const ip = String(address || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
            || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    }
    if (net.isIPv6(ip)) {
        const v = ip.toLowerCase();
        return v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
    }
    return false;
}

/**
 * Whether a request path names the admin panel or the admin API — judged the way the static
 * file server and the router will finally read it, not the way it arrived.
 *
 * Matching the raw prefix was not enough: the general static mount decodes and normalises
 * before it looks on disk, so `/%2Fadmin/admin.js`, `//admin/admin.js`, `/%61dmin/…` and
 * `/js/../admin/index.html` all reached frontend/admin/ while `app.use('/admin')` never saw
 * them. So: decode, turn backslashes into slashes, normalise, lowercase (Express routes are
 * case-insensitive), then compare. A path that does not even decode counts as admin, which only
 * ever means "asked from outside → 404".
 */
function isAdminPath(rawPath) {
    let p;
    try {
        p = decodeURIComponent(String(rawPath || '/'));
    } catch {
        return true;
    }
    p = path.posix.normalize(`/${p.replace(/\\/g, '/')}`).toLowerCase();
    return p === '/admin' || p.startsWith('/admin/') || p === '/api/admin' || p.startsWith('/api/admin/');
}

/**
 * Shuts the admin panel and the admin API to the internet.
 *
 * Since 2026-10-03 SatWire is run from the bookkeeping app on the Pi (NetWorthTracker,
 * `/satwire`), which reaches this API from inside the home network with the password held
 * server-side. Nothing needs the old open path any more — Cloudflare, the tunnel, then only
 * the bearer password in front of every endpoint that refunds, sweeps or deletes — so it is
 * closed, here in the code rather than in Cloudflare's dashboard, where a later edit could
 * quietly reopen it.
 *
 * Both of these must hold:
 *
 *   - No Cloudflare headers. Every request through the tunnel carries `cf-connecting-ip` and
 *     `cf-ray`, added at the edge; a client cannot remove them. Either one means "came in
 *     from the internet", whatever else is true.
 *   - A private peer address. The tunnel itself connects from a private address — that is
 *     why the first test exists — so this one is for a direct hit on the published port
 *     from a public address: a port forward, or an IPv6 route nobody meant to open.
 *
 * A plain 404: from outside there is nothing here. The bearer check still runs behind this
 * for everyone it lets through.
 *
 * Mounted on every path, first, and decides by `isAdminPath` — see there for why a prefix
 * mount was not enough.
 */
function adminFromHomeOnly(req, res, next) {
    const target = req.path || req.url;
    if (!isAdminPath(target)) return next();
    const viaCloudflare = !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
    if (!viaCloudflare && isPrivatePeer(req.socket && req.socket.remoteAddress)) return next();
    if (/^\/*api/i.test(String(target))) {
        return res.status(404).json({ error: 'Not found' });
    }
    return res.status(404).type('text/plain').send('Not found');
}

/**
 * Keeps /admin out of search results.
 *
 * The panel is a static shell — every number on it arrives from an API call that returns
 * 401 without the bearer token, so an indexed copy leaks no data. What it does publish is
 * that an admin panel exists at a guessable path, its section headings, and 51 kB of
 * unminified source naming every admin route.
 *
 * A header rather than a `<meta>` tag, because a meta tag cannot cover admin.js.
 *
 * Deliberately NOT a `Disallow:` in robots.txt: that file is public, so a Disallow line
 * advertises the path to exactly the scrapers it is meant to hide it from — and no scanner
 * reads robots.txt anyway. Against an actual attacker neither of these is the answer; an
 * auth layer in front of the path is. This only addresses search engines.
 */
function noIndexAdmin(req, res, next) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return next();
}

/**
 * Records whether THIS request's URL is safe to cache for a long time.
 *
 * express.static writes its own Cache-Control, so the decision is carried on res.locals and
 * applied in staticCacheHeaders, which runs last.
 */
function markCacheable(req, res, next) {
    res.locals.cacheable = Object.prototype.hasOwnProperty.call(req.query || {}, 'v')
        || String(req.path || '').startsWith('/vendor/');
    return next();
}

/**
 * The `setHeaders` hook for express.static.
 *
 * HTML is never long-cached whatever the URL says: index.html is the file that carries the
 * new `?v=N`, so a stale copy would keep pointing at the old assets forever.
 */
function staticCacheHeaders(res, filePath) {
    const versioned = !!(res.locals && res.locals.cacheable) && !String(filePath).endsWith('.html');
    res.setHeader('Cache-Control', versioned ? CACHE_VERSIONED : CACHE_REVALIDATE);
}

/**
 * The real client address.
 *
 * This app sits behind Cloudflare and a tunnel, so the socket address of a public request is
 * the tunnel's and is identical for every visitor — keying a rate limit on it alone would make
 * one global bucket that any single user could exhaust for everyone. Cloudflare's own header
 * says who it really is, and a client cannot set or remove it at the edge.
 *
 * Anything that did NOT come through the tunnel — since 2026-10-03 that is every admin request
 * — is keyed on the socket address. `X-Forwarded-For` is deliberately ignored: nothing in front
 * of this app sets it except Cloudflare, which also sets cf-connecting-ip, so on its own it is
 * whatever the client typed. Trusting it let a LAN device rotate it for unlimited password
 * guesses, or spoof the bookkeeping app's address and lock the operator out.
 *
 * Moved here from routes/api.js when the admin auth throttle needed the same answer. Two
 * copies of "who is this" is how one limiter ends up bucketing differently from the other.
 */
function clientIp(req) {
    return req.headers['cf-connecting-ip']
        || req.socket?.remoteAddress
        || 'unknown';
}

module.exports = {
    forceHttps,
    adminFromHomeOnly,
    isAdminPath,
    isPrivatePeer,
    noIndexAdmin,
    markCacheable,
    staticCacheHeaders,
    clientIp,
    HSTS_MAX_AGE_SECONDS,
    CACHE_VERSIONED,
    CACHE_REVALIDATE,
};
