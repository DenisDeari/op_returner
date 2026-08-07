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
];

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
        CREATE_REQUEST_EVENTS_SQL,
        CREATE_REQUEST_EVENTS_INDEX_SQL,
        CREATE_WALLET_STATE_SQL,
        CREATE_SYSTEM_SETTINGS_SQL,
    ];
}

module.exports = {
    CREATE_REQUESTS_SQL,
    REQUEST_COLUMN_MIGRATIONS,
    CREATE_REQUEST_EVENTS_SQL,
    CREATE_REQUEST_EVENTS_INDEX_SQL,
    CREATE_WALLET_STATE_SQL,
    CREATE_SYSTEM_SETTINGS_SQL,
    allStatements,
};
