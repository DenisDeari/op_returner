// backend/src/database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

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

function initializeDatabase() {
    const createTableSql = `
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
    db.run(createTableSql, (err) => {
        if (err) {
            console.error("FATAL ERROR: Error creating requests table:", err.message);
            process.exit(1);
        }
        console.log("Table 'requests' created or already exists.");

        // Add targetAddress column if it doesn't exist
        db.run("ALTER TABLE requests ADD COLUMN targetAddress TEXT", (err) => {
            if (err && !err.message.includes("duplicate column name")) {
                console.error("Error adding targetAddress column:", err.message);
            }
        });

        // Add feeRate column if it doesn't exist
        db.run("ALTER TABLE requests ADD COLUMN feeRate INTEGER DEFAULT 2", (err) => {
            if (err && !err.message.includes("duplicate column name")) {
                console.error("Error adding feeRate column:", err.message);
            }
        });

        // Add amountToSend column if it doesn't exist
        db.run("ALTER TABLE requests ADD COLUMN amountToSend INTEGER DEFAULT 0", (err) => {
            if (err && !err.message.includes("duplicate column name")) {
                console.error("Error adding amountToSend column:", err.message);
            }
        });
    });

    // Create wallet_state table for persistent index tracking
    const createWalletStateTableSql = `
        CREATE TABLE IF NOT EXISTS wallet_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            last_derived_index INTEGER NOT NULL DEFAULT 0
        );
    `;
    db.run(createWalletStateTableSql, (err) => {
        if (err) {
            console.error("FATAL ERROR: Error creating wallet_state table:", err.message);
        } else {
            console.log("Table 'wallet_state' created or already exists.");
            db.get("SELECT count(*) as count FROM wallet_state", (err, row) => {
                if (row && row.count === 0) {
                    db.get('SELECT MAX("index") as maxIndex FROM requests', (err, result) => {
                        const startIdx = (result && result.maxIndex !== null) ? result.maxIndex : 0;
                        db.run("INSERT INTO wallet_state (id, last_derived_index) VALUES (1, ?)", [startIdx], (err) => {
                            if (err) console.error("Error initializing wallet_state:", err);
                            else console.log(`Initialized wallet_state with index ${startIdx}`);
                        });
                    });
                }
            });
        }
    });

    // Create system_settings table
    const createSystemSettingsTableSql = `
        CREATE TABLE IF NOT EXISTS system_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `;
    db.run(createSystemSettingsTableSql, (err) => {
        if (err) {
            console.error("Error creating system_settings table:", err.message);
        } else {
            console.log("Table 'system_settings' created or already exists.");
            db.run("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('max_payload_size', '1000')");
        }
    });
}

module.exports = { db, initializeDatabase };
