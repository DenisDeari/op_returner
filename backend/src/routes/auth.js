// backend/src/routes/auth.js
//
// The admin bearer check, in one place.
//
// It used to be written inline in admin.js. Once a second admin-only router existed
// (the wallet), two copies of an authentication check would have been two things to keep
// in step, and the one that fell behind would be the one guarding the seed's balances.
//
// Cloudflare Access sits in front of the /admin PATH, but deliberately NOT in front of
// /api/admin — putting it there would hand the panel's own fetch() calls a login page
// instead of JSON. So this file is the only thing standing in front of the endpoints that
// refund, fulfil and delete, and it is reachable from the open internet. Until 2026-08-12
// it would answer an unlimited number of guesses.

const crypto = require('crypto');
const notifier = require('../notifier');
const { clientIp } = require('../http_hygiene');

// A wrong password costs an attacker one request. These numbers make the fifth wrong
// password cost fifteen minutes instead.
//
// Chosen to be survivable by the operator: the window is short, it slides, and a correct
// password clears the bucket outright. Locking for an hour would turn a fat-fingered
// password into an hour of not being able to refund somebody.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

// Per IP, not global. A global counter would let anyone on the internet lock the operator
// out of their own money by guessing wrong five times — turning a brute-force defence into
// a denial-of-service handle.
const attempts = new Map(); // ip -> [timestamps of failures]

// An attacker rotating addresses must not be able to grow this map without bound. At the
// cap the least recently seen address is evicted, which is also the one least likely to be
// mid-attack. Map preserves insertion order and every failure re-inserts, so the first key
// is the oldest.
const MAX_TRACKED_IPS = 5000;

/** Failures for this address inside the window, with expired ones dropped. */
function recentFailures(ip, now) {
    const stamps = attempts.get(ip);
    if (!stamps) return [];
    const cutoff = now - FAIL_WINDOW_MS;
    const recent = stamps.filter((t) => t > cutoff);
    if (recent.length === 0) attempts.delete(ip);
    else attempts.set(ip, recent);
    return recent;
}

function recordFailure(ip, now) {
    const recent = recentFailures(ip, now);
    recent.push(now);
    attempts.set(ip, recent);
    if (attempts.size > MAX_TRACKED_IPS) {
        const oldest = attempts.keys().next().value;
        if (oldest !== undefined) attempts.delete(oldest);
    }
    return recent.length;
}

/**
 * Constant-time string comparison.
 *
 * A plain === leaks how many leading characters were right, one request at a time. That
 * was always true of this check, but it now also guards the wallet view, so it is worth
 * the two extra lines. Lengths are compared through the same path by hashing first, so
 * the comparison is over equal-length buffers.
 */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/**
 * @param {object} config - needs ADMIN_PASSWORD
 * @returns {function} Express middleware
 */
function requireAdmin(config) {
    return function protect(req, res, next) {
        const expected = config.ADMIN_PASSWORD;
        // No password configured means no admin access at all. Falling through to "allow"
        // here would expose every balance and every request to the open internet.
        //
        // Checked BEFORE the throttle, and deliberately not counted as a failed attempt: a
        // misconfigured server is not somebody guessing, and filling the map with it would
        // lock out the operator the moment the password was configured correctly.
        if (!expected) {
            return res.status(503).json({ error: 'Admin access is not configured on this server.' });
        }

        const ip = clientIp(req);
        const now = Date.now();
        const failures = recentFailures(ip, now);

        if (failures.length >= MAX_FAILURES) {
            // The password is not compared at all while locked. That is not only cheaper —
            // it also means the timing of a locked response says nothing about the guess.
            const retryAfterMs = (failures[0] + FAIL_WINDOW_MS) - now;
            const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
            res.setHeader('Retry-After', String(retryAfter));
            return res.status(429).json({
                error: 'Too many failed attempts. Try again later.',
                retryAfterSeconds: retryAfter,
            });
        }

        const authHeader = req.headers.authorization;
        if (authHeader && safeEqual(authHeader, `Bearer ${expected}`)) {
            // A correct password clears the bucket. Without this, an operator who mistyped
            // four times and then got it right would still be four failures from a lockout
            // for the next quarter of an hour.
            attempts.delete(ip);
            return next();
        }

        const count = recordFailure(ip, now);
        if (count === MAX_FAILURES) {
            // Once per lockout, not once per blocked request. A brute-force run would
            // otherwise spend the notifier's whole hourly budget and the operator would stop
            // hearing about orders — the thing an attacker would most like.
            //
            // What actually guarantees that is the 429 branch above returning before this
            // line is ever reached again; the `===` is belt and braces. A FRESH lockout
            // after the window has passed does notify again, which is correct: that is a new
            // attempt, not the same one continuing.
            console.warn(`[Auth] ${MAX_FAILURES} failed admin logins from ${ip} — locked for ${FAIL_WINDOW_MS / 60000} minutes.`);
            notifier.notifyAdminLockout({
                ip,
                failures: count,
                minutes: Math.round(FAIL_WINDOW_MS / 60000),
            }, config);
        }
        return res.status(401).json({ error: 'Unauthorized' });
    };
}

/** Test seams. Never called by the service. */
function _resetThrottle() {
    attempts.clear();
}
function _trackedIps() {
    return attempts.size;
}

module.exports = {
    requireAdmin,
    _resetThrottle,
    _trackedIps,
    FAIL_WINDOW_MS,
    MAX_FAILURES,
    MAX_TRACKED_IPS,
};
