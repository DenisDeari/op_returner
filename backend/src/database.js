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
            } else {
                console.log("Column 'targetAddress' checked/added.");
            }
        });

        // Add isPublic column if it doesn't exist
        db.run("ALTER TABLE requests ADD COLUMN isPublic INTEGER DEFAULT 1", (err) => {
            if (err && !err.message.includes("duplicate column name")) {
                console.error("Error adding isPublic column:", err.message);
            } else {
                console.log("Column 'isPublic' checked/added.");
            }
        });

        // Add feeRate column if it doesn't exist
        db.run("ALTER TABLE requests ADD COLUMN feeRate INTEGER DEFAULT 2", (err) => {
            if (err && !err.message.includes("duplicate column name")) {
                console.error("Error adding feeRate column:", err.message);
            } else {
                console.log("Column 'feeRate' checked/added.");
            }
        });

        // Add amountToSend column if it doesn't exist
        db.run("ALTER TABLE requests ADD COLUMN amountToSend INTEGER DEFAULT 0", (err) => {
            if (err && !err.message.includes("duplicate column name")) {
                console.error("Error adding amountToSend column:", err.message);
            } else {
                console.log("Column 'amountToSend' checked/added.");
            }
        });
    });
}

module.exports = { db, initializeDatabase };
