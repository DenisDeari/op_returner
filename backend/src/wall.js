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
//       `publicAt` is what makes this safe, because it is a genuinely new column and so
//       cannot have inherited anything. The invariant is not "the customer consented" —
//       it is narrower and stronger: **publicAt is only ever set by a deliberate act.**
//       Either the intake handler stamped it because the customer ticked the box, or an
//       operator put the message on the wall on purpose. Nothing sets it by default, so
//       anything carrying a 1 it merely inherited has no stamp and stays off.
//
//       `publicSource` records which of those two it was. It does not affect this query
//       — an operator-published message is as public as a customer-published one — but it
//       keeps "did this person agree to appear on our website?" an answerable question.
//       Messages published before the wall existed were never offered the choice.
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
//
// `payloadKind` is safe to emit and necessary: it is our own closed enum, written only by
// intake and validated against the payload's actual magic bytes, never free text from a
// customer. The frontend needs it to know whether `message` is words to put in a
// textContent node or base64 to hand to an <img>, and GUESSING would be the bug — sniffing
// a payload client-side to decide how to render it is exactly the content-type confusion
// that turns a message wall into an XSS surface.
//
// What it is NOT is permission to render arbitrary types. The enum is text, image/webp and
// image/jpeg — all inert raster. Never add a type the browser executes or parses as markup
// (SVG above all: it carries <script> and <foreignObject>), and never build a `data:` URL
// from a type that did not come from this list.

const { dbAll, dbGet } = require('./db_utils');
const payload = require('./payload');

/** Nobody needs more than this, and it bounds the cost of the one public query. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/**
 * How long a wall read is reused. The wall changes only when an order completes — minutes
 * apart at best — so a short cache costs nothing in freshness and takes the homepage off
 * the serialized database handle the money paths share.
 */
const CACHE_MS = 10 * 1000;

// THE PREDICATE, ONCE. Two queries need it now — the listing below and the per-payload
// fetch that serves an image's bytes — and they must never drift apart. A payload endpoint
// with a weaker WHERE would happily serve the bytes of a message the operator had hidden,
// a customer had withdrawn, or retention had redacted, while the listing correctly refused
// to mention it. The listing is the visible guard; this one would fail silently.
//
// Interpolated into both statements so there is exactly one copy in the process, and the
// harness asserts both carry it.
const WALL_WHERE_SQL = `
     WHERE status = 'op_return_broadcasted'
       AND isPublic = 1
       AND publicAt IS NOT NULL
       AND hiddenByAdmin = 0
       AND archivedAt IS NULL
       AND redactedAt IS NULL
       AND message <> ''
`;

// The listing NEVER carries image bytes.
//
// It used to. `message` holds base64 for an image row, so at the 20,000-byte limit a
// single image is ~27 kB of JSON and a full page of 50 is over a megabyte — served
// unauthenticated, uncompressed and deliberately un-rate-limited, on every single homepage
// visit. The CASE keeps those bytes out of the result set entirely rather than fetching
// them and discarding them afterwards, so they never leave SQLite either.
//
// Text stays inline: it is capped at 1,000 bytes and is what the card actually renders.
// An image row carries its `opReturnTxId`, which the client turns into an <img src> against
// the payload endpoint below.
const WALL_SELECT_SQL = `
    SELECT CASE WHEN payloadKind IN ('image/webp', 'image/jpeg') THEN NULL ELSE message END AS message,
           payloadKind,
           opReturnTxId,
           COALESCE(lastAttemptAt, paymentConfirmedAt, createdAt) AS publishedAt
      FROM requests
     ${WALL_WHERE_SQL}
     ORDER BY COALESCE(lastAttemptAt, paymentConfirmedAt, createdAt) DESC
     LIMIT ?
`;

// One published payload, addressed by its transaction id.
//
// Keyed on opReturnTxId and NOT on the request id, deliberately. A request id is a bearer
// capability — GET /api/request-status/:id is public — so putting one in a URL the homepage
// emits would hand every visitor read access to that order. The transaction id is already
// public: it is in the listing, it is printed on the card, and it is on the chain.
const WALL_PAYLOAD_SQL = `
    SELECT message, payloadKind
      FROM requests
     ${WALL_WHERE_SQL}
       AND opReturnTxId = ?
     LIMIT 1
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

/** A Bitcoin txid and nothing else, checked before it reaches a query. */
const TXID_RE = /^[0-9a-f]{64}$/;

/**
 * The decoded bytes of one published image, or null.
 *
 * Runs the SAME predicate as the listing, so a row the wall would not mention cannot have
 * its bytes served either. Returns null for every refusal — not found, hidden, archived,
 * redacted, a text row, or a payload that will not decode — because the caller must not be
 * able to tell those apart. A 404 that means "exists but hidden" is an oracle.
 *
 * Deliberately NOT cached in this module. The listing cache exists to keep the homepage
 * off the money paths' serialized handle; this is one indexed lookup, served with immutable
 * cache headers, so the browser and Cloudflare do the caching. Holding decoded image bytes
 * in process memory would be the same megabyte problem moved one layer down.
 */
async function findPublicPayload(db, opReturnTxId) {
    const txid = String(opReturnTxId || '').toLowerCase();
    if (!TXID_RE.test(txid)) return null;

    const row = await dbGet(db, WALL_PAYLOAD_SQL, [txid]);
    if (!row || !payload.isImage(row.payloadKind)) return null;

    try {
        return { bytes: payload.decode(row.message, row.payloadKind), kind: row.payloadKind };
    } catch {
        // Stored payload does not decode. Nothing to serve and nothing the caller can do.
        return null;
    }
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
    findPublicPayload,
    invalidate,
    clampLimit,
    WALL_WHERE_SQL,
    WALL_PAYLOAD_SQL,
    WALL_SELECT_SQL,
    MAX_LIMIT,
    DEFAULT_LIMIT,
    CACHE_MS,
};
