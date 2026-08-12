// backend/src/http_hygiene.js
//
// The three pieces of HTTP hygiene that sit in front of everything else: forcing TLS,
// keeping the admin panel out of search results, and deciding what may be cached.
//
// They live here rather than inline in server.js for one reason: server.js opens the
// production database and binds a port the moment it is required, so nothing in it can be
// tested. This module is side-effect free — the same reason schema.js is.
//
// None of this is a money path. It is in front of one.

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
 * This app sits behind Cloudflare and a tunnel, so `req.ip` is the proxy's address and is
 * identical for every visitor — keying a rate limit on it alone would make one global
 * bucket that any single user could exhaust for everyone.
 *
 * Moved here from routes/api.js when the admin auth throttle needed the same answer. Two
 * copies of "who is this" is how one limiter ends up bucketing differently from the other.
 */
function clientIp(req) {
    return req.headers['cf-connecting-ip']
        || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.ip
        || req.socket?.remoteAddress
        || 'unknown';
}

module.exports = {
    forceHttps,
    noIndexAdmin,
    markCacheable,
    staticCacheHeaders,
    clientIp,
    HSTS_MAX_AGE_SECONDS,
    CACHE_VERSIONED,
    CACHE_REVALIDATE,
};
