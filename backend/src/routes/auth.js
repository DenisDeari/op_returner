// backend/src/routes/auth.js
//
// The admin bearer check, in one place.
//
// It used to be written inline in admin.js. Once a second admin-only router existed
// (the wallet), two copies of an authentication check would have been two things to keep
// in step, and the one that fell behind would be the one guarding the seed's balances.

const crypto = require('crypto');

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
        if (!expected) {
            return res.status(503).json({ error: 'Admin access is not configured on this server.' });
        }
        const authHeader = req.headers.authorization;
        if (authHeader && safeEqual(authHeader, `Bearer ${expected}`)) {
            return next();
        }
        return res.status(401).json({ error: 'Unauthorized' });
    };
}

module.exports = { requireAdmin };
