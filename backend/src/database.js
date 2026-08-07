// backend/src/database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const schema = require('./schema');

const DATA_DIR = path.join(__dirname, '../data');
const DB_FILE = path.join(DATA_DIR, 'requests.db');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
    console.log("Created data directory:", DATA_DIR);
}

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        console.error("FATAL ERROR: Error opening database:", err.message);
        process.exit(1);
    }
    console.log(`Connected to the SQLite database: ${DB_FILE}`);
});

/**
 * Creates tables and applies additive column migrations.
 *
 * @param {function} [onReady] - Invoked once the requests table and all of its column
 *   migrations have been applied. Scheduled jobs must wait for this: they query columns
 *   that only exist after the migrations run, and on a fresh database they would
 *   otherwise race the CREATE TABLE and fail with "no such table".
 */
function initializeDatabase(onReady) {
    // Four independent async chains run below (requests, wallet_state, system_settings,
    // request_events).
    // onReady fires only once ALL of them have finished. The server must not begin
    // accepting traffic before that: an early request would otherwise reach a database
    // with no wallet_state row and fail with "Wallet state not initialized".
    const pendingSteps = new Set(['requests', 'wallet_state', 'system_settings', 'request_events']);
    function markStepDone(step) {
        pendingSteps.delete(step);
        if (pendingSteps.size === 0) {
            console.log('Database initialization complete.');
            if (typeof onReady === 'function') onReady();
        }
    }

    const createTableSql = schema.CREATE_REQUESTS_SQL;

    db.run(createTableSql, (err) => {
        if (err) {
            console.error("FATAL ERROR: Error creating requests table:", err.message);
            process.exit(1);
        }
        console.log("Table 'requests' created or already exists.");

        // Additive, idempotent column migrations.
        // ALTER TABLE ADD COLUMN never rewrites or drops existing rows, and the
        // "duplicate column name" error is the expected no-op on an already-migrated DB.
        const columnMigrations = schema.REQUEST_COLUMN_MIGRATIONS;

        let remaining = columnMigrations.length;
        for (const migration of columnMigrations) {
            db.run(`ALTER TABLE requests ${migration}`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error(`Error applying migration "${migration}":`, err.message);
                }
                if (--remaining === 0) {
                    console.log('Schema migrations applied.');
                    markStepDone('requests');
                }
            });
        }
    });

    // Create wallet_state table for persistent index tracking
    const createWalletStateTableSql = schema.CREATE_WALLET_STATE_SQL;
    db.run(createWalletStateTableSql, (err) => {
        if (err) {
            console.error("FATAL ERROR: Error creating wallet_state table:", err.message);
            return markStepDone('wallet_state');
        }
        console.log("Table 'wallet_state' created or already exists.");
        db.get("SELECT count(*) as count FROM wallet_state", (err, row) => {
            if (!row || row.count !== 0) {
                return markStepDone('wallet_state');
            }
            // Seed from the highest index already used, so a rebuilt wallet_state never
            // re-issues an address that a previous request was quoted.
            db.get('SELECT MAX("index") as maxIndex FROM requests', (err, result) => {
                const startIdx = (result && result.maxIndex !== null) ? result.maxIndex : 0;
                db.run("INSERT INTO wallet_state (id, last_derived_index) VALUES (1, ?)", [startIdx], (err) => {
                    if (err) console.error("Error initializing wallet_state:", err);
                    else console.log(`Initialized wallet_state with index ${startIdx}`);
                    markStepDone('wallet_state');
                });
            });
        });
    });

    // Create system_settings table
    const createSystemSettingsTableSql = schema.CREATE_SYSTEM_SETTINGS_SQL;
    db.run(createSystemSettingsTableSql, (err) => {
        if (err) {
            console.error("Error creating system_settings table:", err.message);
            return markStepDone('system_settings');
        }
        console.log("Table 'system_settings' created or already exists.");
        db.run("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('max_payload_size', '1000')", () => {
            markStepDone('system_settings');
        });
    });

    // Durable per-request history. Follows the wallet_state pattern rather than the
    // requests one: markStepDone is called on EVERY path, including failure, and nothing
    // here calls process.exit. onReady is the sole caller of app.listen and of the
    // scheduled jobs, so a path through this chain that forgot to mark itself done would
    // leave the HTTP listener unbound and reconcile never started — a total outage behind
    // a process that looks perfectly healthy. An event log is a convenience; it must
    // never be able to take the service down.
    db.run(schema.CREATE_REQUEST_EVENTS_SQL, (err) => {
        if (err) {
            console.error("Error creating request_events table:", err.message);
            return markStepDone('request_events');
        }
        console.log("Table 'request_events' created or already exists.");
        db.run(schema.CREATE_REQUEST_EVENTS_INDEX_SQL, (indexErr) => {
            if (indexErr) console.error("Error creating request_events index:", indexErr.message);
            markStepDone('request_events');
        });
    });
}

module.exports = { db, initializeDatabase };
