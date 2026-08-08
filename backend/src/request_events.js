// backend/src/request_events.js
//
// Durable, append-only history of what happened to each request.
//
// The only other log in this service is event_log.js, a 300-entry in-memory ring buffer
// of console.warn/error that is wiped on every restart and is not keyed by request. It
// answers "is anything wrong right now?"; it cannot answer "what happened to this order?"
// a week later. Rows in `requests` are archived rather than deleted now, so the request
// survives forever — this makes its story survive with it.
//
// TWO RULES, both load-bearing:
//
//   1. Writing an event must never break or delay the caller. Every write here is
//      fire-and-forget and swallows its own errors. This is called from the middle of
//      building and broadcasting Bitcoin transactions; a logging problem must not be able
//      to fail a payment, and an `await` on an fsync must not be able to slow one down.
//
//   2. Only lifecycle transitions. The database runs in journal_mode=delete on the same
//      serialized handle the money paths use, so every insert is its own fsync. Recording
//      per poll, per scan or per provider attempt would put that fsync in the path of a
//      transaction build. If you find yourself adding an event inside a loop, don't.

const KINDS = Object.freeze({
    CREATED: 'created',
    WEBHOOKS_REGISTERED: 'webhooks_registered',
    WEBHOOKS_RETIRED: 'webhooks_retired',
    NOTIFICATION_REJECTED: 'notification_rejected',
    PAYMENT_DETECTED: 'payment_detected',
    PAYMENT_CONFIRMED: 'payment_confirmed',
    UNDERPAID: 'underpaid',
    FULFIL_ATTEMPT: 'fulfil_attempt',
    PUBLISHED: 'published',
    FULFIL_FAILED: 'fulfil_failed',
    REFUND_STARTED: 'refund_started',
    REFUNDED: 'refunded',
    REFUND_FAILED: 'refund_failed',
    FEEDBACK: 'feedback',
    CANCELLED: 'cancelled',
    ARCHIVED: 'archived',
    UNEXPECTED_PAYMENT: 'unexpected_payment',
    REDACTED: 'redacted',
    // The customer's wall opt-in at intake, and the operator's moderation decisions
    // afterwards. A hide is a judgement about someone's published words, so the record of
    // who did it and when has to outlive the boolean it flipped.
    WALL_OPT_IN: 'wall_opt_in',
    WALL_HIDDEN: 'wall_hidden',
    WALL_SHOWN: 'wall_shown',
    // The operator putting a message on the wall that its author never opted in to —
    // messages published before the wall existed. Kept distinct from WALL_OPT_IN so the
    // history never implies a consent that was not given, and from WALL_SHOWN, which
    // means restoring something after a hide.
    WALL_PUBLISHED_BY_OPERATOR: 'wall_published_by_operator',
});

const MAX_DETAIL_CHARS = 2000;

/**
 * Appends one event. Never throws, never returns a promise the caller is expected to
 * await, and never reports failure upward — see rule 1 above.
 */
function record(db, requestId, kind, detail) {
    if (!db || !requestId || !kind) return;
    try {
        const text = detail == null
            ? null
            : String(typeof detail === 'object' ? safeJson(detail) : detail).slice(0, MAX_DETAIL_CHARS);
        db.run(
            'INSERT INTO request_events (requestId, at, kind, detail) VALUES (?, ?, ?, ?)',
            [requestId, new Date().toISOString(), kind, text],
            (err) => {
                if (err) console.warn(`[RequestEvents] Could not record ${kind} for ${requestId}: ${err.message}`);
            }
        );
    } catch (error) {
        console.warn(`[RequestEvents] Unexpected error recording ${kind}: ${error.message}`);
    }
}

function safeJson(value) {
    try { return JSON.stringify(value); } catch { return '[unserialisable]'; }
}

/** The full history of one request, oldest first. Read-only; used by the admin panel. */
function forRequest(db, requestId) {
    return new Promise((resolve) => {
        db.all(
            'SELECT id, at, kind, detail FROM request_events WHERE requestId = ? ORDER BY id ASC',
            [requestId],
            (err, rows) => {
                if (err) {
                    console.warn(`[RequestEvents] Could not read history for ${requestId}: ${err.message}`);
                    return resolve([]);
                }
                resolve(rows || []);
            }
        );
    });
}

module.exports = { record, forRequest, KINDS };
