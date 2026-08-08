// backend/src/wall.js
//
// The public message wall: the messages customers chose to show on satwire.io.
//
// This is the only place in the service that serves customer-written text to strangers,
// so the query is kept here rather than inline in the route, and exported, so the test
// harness asserts against the same string the endpoint actually runs.
//
// THE WHERE CLAUSE IS THE FEATURE. Every term in it is load-bearing:
//
//   status = 'op_return_broadcasted'
//       Only messages that actually reached the chain. Written in exactly one place,
//       request_service.js.
//
//   isPublic = 1 AND publicAt IS NOT NULL AND hiddenByAdmin = 0
//       The customer said yes, and the operator has not said no.
//
//       `publicAt IS NOT NULL` is not redundant, and removing it is a privacy incident.
//       The production database carries a LEGACY `isPublic INTEGER DEFAULT 1` column from
//       the pre-2.0 schema, dropped from the code in a116ced but never from the table —
//       ALTER TABLE ADD COLUMN cannot be undone. Our own migration therefore no-ops with
//       "duplicate column name" and the default stays 1, so:
//         - every row that existed before this feature reads isPublic = 1, and
//         - every new row is born isPublic = 1, because queue.js's INSERT omits the column.
//       Consent is proved by `publicAt`, which is a genuinely new column: NULL unless the
//       intake handler stamped it because the customer ticked the box. Anything that
//       inherited a 1 from the legacy default has no stamp and stays off the wall.
//
//   archivedAt IS NULL
//       Not decoration. Archiving deliberately does NOT overwrite `status`, so a request
//       the customer CANCELLED still reads 'op_return_broadcasted' if it was later paid
//       and force-fulfilled by an operator. Without this term, a message someone
//       explicitly withdrew appears on the public homepage. Every other read path in the
//       service carries the same guard — routes/webhook.js, routes/api.js, routes/admin.js
//       — and this one has the loudest consequence.
//
//   redactedAt IS NULL AND message <> ''
//       Defence in depth. Redaction empties `message` to '' rather than NULL (it is
//       NOT NULL in the base schema) and today cannot reach a published row, because it
//       requires opReturnTxId IS NULL. If that guard is ever relaxed, the wall renders
//       blank cards instead of leaking — a visible failure rather than a silent one.
//
// ORDERING: not paymentConfirmedAt. That column is NULL on any row published through the
// admin's manual fulfil, which requires no confirmed payment (routes/admin.js), and on
// underpaid rows the webhook recorded without it. SQLite sorts NULL lowest, so DESC would
// bury exactly those messages at the bottom of the wall forever. lastAttemptAt is stamped
// in the same UPDATE as the success write (request_service.js) and nothing can overwrite
// it afterwards, because every retry path requires opReturnTxId IS NULL.
//
// THE COLUMN LIST IS A SECURITY BOUNDARY, not a presentation choice. `id` is a bearer
// capability: GET /api/request-status/:requestId is public, so anyone holding a request id
// can read that order. The wall must never emit `id` or `address`. If a "hide this" button
// ever needs an id, it belongs in the admin panel, which has its own authenticated listing.

const { dbAll } = require('./db_utils');

/** Nobody needs more than this, and it bounds the cost of the one public query. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/**
 * How long a wall read is reused. The wall changes only when an order completes — minutes
 * apart at best — so a short cache costs nothing in freshness and takes the homepage off
 * the serialized database handle the money paths share.
 */
const CACHE_MS = 10 * 1000;

const WALL_SELECT_SQL = `
    SELECT message,
           opReturnTxId,
           COALESCE(lastAttemptAt, paymentConfirmedAt, createdAt) AS publishedAt
      FROM requests
     WHERE status = 'op_return_broadcasted'
       AND isPublic = 1
       AND publicAt IS NOT NULL
       AND hiddenByAdmin = 0
       AND archivedAt IS NULL
       AND redactedAt IS NULL
       AND message <> ''
     ORDER BY COALESCE(lastAttemptAt, paymentConfirmedAt, createdAt) DESC
     LIMIT ?
`;

let cache = null; // { at: number, rows: object[] }

/**
 * The published, opted-in, un-hidden messages, newest first.
 *
 * @param {object} db
 * @param {number} [limit]
 * @returns {Promise<{messages: object[], cachedAt: string}>}
 */
async function listPublicMessages(db, limit = DEFAULT_LIMIT) {
    const want = clampLimit(limit);

    // One query regardless of the limit asked for: fetch the cap once, slice per caller.
    if (!cache || Date.now() - cache.at > CACHE_MS) {
        const rows = await dbAll(db, WALL_SELECT_SQL, [MAX_LIMIT]);
        cache = { at: Date.now(), rows: rows || [] };
    }

    return {
        messages: cache.rows.slice(0, want),
        cachedAt: new Date(cache.at).toISOString(),
    };
}

function clampLimit(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
}

/**
 * Drops the cached page. Called when an operator hides or shows a message, so moderation
 * takes effect immediately rather than up to CACHE_MS later — the one case where the delay
 * would be the wrong answer.
 */
function invalidate() {
    cache = null;
}

module.exports = {
    listPublicMessages,
    invalidate,
    clampLimit,
    WALL_SELECT_SQL,
    MAX_LIMIT,
    DEFAULT_LIMIT,
    CACHE_MS,
};
