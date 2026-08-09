// backend/src/schema.js
//
// Every DDL statement in one place, with no side effects.
//
// database.js opens the real database file the moment it is required, and exits the
// process if it cannot. That makes it impossible to require from a test, so the external
// harnesses used to hand-write their own CREATE TABLE — which silently drifted from
// production and only surfaced when a query started referencing a column the test schema
// did not have. Both sides now read the schema from here, so they cannot disagree.

const CREATE_REQUESTS_SQL = `
    CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        address TEXT UNIQUE NOT NULL,
        derivationPath TEXT NOT NULL,
        "index" INTEGER UNIQUE NOT NULL,
        requiredAmountSatoshis INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_payment',
        createdAt TEXT NOT NULL,
        blockcypherHookId TEXT,
        paymentTxId TEXT,
        paymentReceivedSatoshis INTEGER,
        paymentConfirmationCount INTEGER,
        paymentConfirmedAt TEXT,
        opReturnTxId TEXT,
        opReturnTxHex TEXT
    );
`;

// Additive, idempotent column migrations applied on every boot.
// ALTER TABLE ADD COLUMN never rewrites or drops existing rows, and the
// "duplicate column name" error is the expected no-op on an already-migrated DB.
const REQUEST_COLUMN_MIGRATIONS = [
    'ADD COLUMN targetAddress TEXT',
    'ADD COLUMN feeRate INTEGER DEFAULT 2',
    'ADD COLUMN amountToSend INTEGER DEFAULT 0',
    // The BIP32 path of the change output, recorded so operator revenue is recoverable
    // from the seed directly rather than relying on a wallet's gap-limit scan finding a
    // sparsely-used change index.
    'ADD COLUMN changePath TEXT',
    'ADD COLUMN failureReason TEXT',
    'ADD COLUMN attemptCount INTEGER DEFAULT 0',
    'ADD COLUMN lastAttemptAt TEXT',
    // Refunds: refundAddress is the payer's address, captured from the payment tx.
    'ADD COLUMN refundAddress TEXT',
    'ADD COLUMN refundTxId TEXT',
    'ADD COLUMN refundedAt TEXT',
    // Kept separate from failureReason so a refund error never overwrites the
    // fulfilment diagnostic that the retry logic classifies against.
    'ADD COLUMN refundFailureReason TEXT',
    // Customer message left on a failed request, shown in the admin panel.
    'ADD COLUMN userFeedback TEXT',
    'ADD COLUMN userFeedbackAt TEXT',
    // Retention. Rows are archived rather than deleted, so the record of what a customer
    // asked for — and which address it was quoted at — survives forever. `status` is
    // deliberately NOT overwritten: archivedAt marks the row dead, status still says how
    // it died, which is the part worth studying later.
    'ADD COLUMN archivedAt TEXT',
    'ADD COLUMN archivedReason TEXT',
    // Kept separate from blockcypherHookId rather than nulling it. deleteWebhook has no
    // return value on any path — missing token, 204, 404 and a network error are all
    // indistinguishable `undefined` — so we can never know a hook is really gone, and
    // discarding the id would throw away the only handle to a possibly-live one.
    'ADD COLUMN webhooksRetiredAt TEXT',
    // Long-horizon redaction. The row survives — only its content is dropped, so a late
    // payment stays attributable to an address. messageBytes preserves the one thing
    // about the message worth studying after the text itself is gone.
    'ADD COLUMN redactedAt TEXT',
    'ADD COLUMN messageBytes INTEGER',
    // The public message wall.
    //
    // WARNING — `isPublic` ALREADY EXISTS IN PRODUCTION, as `INTEGER DEFAULT 1`, left over
    // from the pre-2.0 schema (the code went in a116ced; the column could not follow,
    // because ADD COLUMN cannot be undone). This migration therefore no-ops there with
    // "duplicate column name" and THE LIVE DEFAULT REMAINS 1, not the 0 written below.
    // A fresh database gets 0; the live one does not. Do not trust this default.
    //
    // Two things compensate, and both must stay:
    //   - routes/api.js writes isPublic explicitly on every intake, 0 or 1.
    //   - wall.js additionally requires `publicAt IS NOT NULL`, which is a genuinely new
    //     column and so cannot have inherited anything.
    // Changing the default here fixes nothing: SQLite cannot alter a column default
    // without rebuilding the table, and that is not worth doing to a money database.
    //
    // isPublic is the customer's own choice, taken at intake and never changed afterwards.
    // hiddenByAdmin is the operator's moderation override and is deliberately a SEPARATE
    // column: hiding a message must not overwrite what the customer asked for, so that
    // un-hiding restores their intent rather than guessing at it.
    //
    // Both default to 0, so every row that already exists stays off the wall. Messages
    // published before the wall existed were never offered the choice, and inferring
    // consent from silence is not a choice.
    'ADD COLUMN isPublic INTEGER DEFAULT 0',
    'ADD COLUMN hiddenByAdmin INTEGER DEFAULT 0',
    'ADD COLUMN publicAt TEXT',
    // WHO decided this message goes on the wall: 'customer' (they ticked the box at
    // intake) or 'operator' (we put it there).
    //
    // Not decoration. Messages published before the wall existed were never offered the
    // choice, and some of them are on the wall now because the operator decided they
    // should be. That is a legitimate call — the text is already permanently public on
    // the chain — but it is a different fact from a customer consenting, and the two must
    // not become indistinguishable. "Did this person agree to appear on our website?" is
    // a question worth being able to answer years later.
    'ADD COLUMN publicSource TEXT',
    // When the OP_RETURN transaction was seen in a block, and which one.
    //
    // A UI SIGNAL ONLY. Nothing in refund.js, reconcile.js or cleanup.js may branch on
    // it, and nothing may treat it as final: a one-block reorg un-mines a transaction,
    // and a column that quietly became a money decision would turn a reorg into a refund.
    // Its two legitimate readers are the customer's progress rail and the operator alert
    // for "broadcast days ago and still not mined".
    //
    // Deliberately NOT a new status value: wall.js filters on
    // `status = 'op_return_broadcasted'`, so an 'op_return_confirmed' status would empty
    // the public wall of every message the moment it got mined.
    'ADD COLUMN opReturnConfirmedAt TEXT',
    'ADD COLUMN opReturnBlockHeight INTEGER',
    // What `message` actually holds: 'text' (UTF-8, the only thing that existed before
    // this column) or an image mime type, in which case the column holds BASE64 and the
    // chain gets the decoded bytes.
    //
    // NULL means text. Deliberately not backfilled and deliberately not NOT NULL: every
    // row written before images existed is text, so NULL already carries the right
    // meaning, and payload.js normalises it. A backfill would rewrite a money database to
    // say something it already said.
    //
    // The consequence to keep in mind: for an image row, `Buffer.byteLength(message)` is
    // the base64 length and NOT what goes on chain. Nothing may price from it — see
    // payload.js byteLength().
    'ADD COLUMN payloadKind TEXT',
];

// The only index on `requests`.
//
// Every other query in this service is either keyed on the primary key or runs from a
// scheduled job where a table scan is fine. The wall is neither: it is public, it is
// unauthenticated, it is hit on every homepage render, and `requests` grows forever now
// that rows are archived rather than deleted. Left unindexed it is a full scan of a
// monotonically growing table on the same serialized handle the money paths use.
//
// Column order matches the wall's WHERE clause so SQLite can use the whole index.
// MUST be created after REQUEST_COLUMN_MIGRATIONS have run — three of these four columns
// arrive via ALTER TABLE.
const CREATE_REQUESTS_WALL_INDEX_SQL = `
    CREATE INDEX IF NOT EXISTS idx_requests_wall
        ON requests (status, isPublic, hiddenByAdmin, archivedAt);
`;

// Durable, append-only history of what happened to each request.
//
// event_log.js is a 300-entry in-memory ring buffer of console.warn/error, wiped on every
// restart and not keyed by request — useful for glancing at the admin panel, useless for
// answering "what happened to this order?" a week later. This table is the answer to that.
//
// No FOREIGN KEY: PRAGMA foreign_keys is 0 on this database, so the clause would be inert
// and misleading. Rows are never deleted from `requests`, so there is nothing to cascade.
//
// Deliberately written only at lifecycle transitions, never per poll or per scan. The
// database runs in journal_mode=delete on the same serialized handle the money paths use,
// so every insert is its own fsync; a chatty event would slow down a transaction build.
const CREATE_REQUEST_EVENTS_SQL = `
    CREATE TABLE IF NOT EXISTS request_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requestId TEXT NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT
    );
`;

const CREATE_REQUEST_EVENTS_INDEX_SQL = `
    CREATE INDEX IF NOT EXISTS idx_request_events_request
        ON request_events (requestId, id);
`;

const CREATE_WALLET_STATE_SQL = `
    CREATE TABLE IF NOT EXISTS wallet_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_derived_index INTEGER NOT NULL DEFAULT 0
    );
`;

const CREATE_SYSTEM_SETTINGS_SQL = `
    CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
`;

/**
 * Every statement needed to build the schema from nothing, in order. Used by the external
 * test harnesses so their throwaway databases match production exactly.
 */
function allStatements() {
    return [
        CREATE_REQUESTS_SQL,
        ...REQUEST_COLUMN_MIGRATIONS.map((m) => `ALTER TABLE requests ${m}`),
        // After the ALTERs: it indexes columns three of which they add.
        CREATE_REQUESTS_WALL_INDEX_SQL,
        CREATE_REQUEST_EVENTS_SQL,
        CREATE_REQUEST_EVENTS_INDEX_SQL,
        CREATE_WALLET_STATE_SQL,
        CREATE_SYSTEM_SETTINGS_SQL,
    ];
}

module.exports = {
    CREATE_REQUESTS_SQL,
    REQUEST_COLUMN_MIGRATIONS,
    CREATE_REQUESTS_WALL_INDEX_SQL,
    CREATE_REQUEST_EVENTS_SQL,
    CREATE_REQUEST_EVENTS_INDEX_SQL,
    CREATE_WALLET_STATE_SQL,
    CREATE_SYSTEM_SETTINGS_SQL,
    allStatements,
};
