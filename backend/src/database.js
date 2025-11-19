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
    });
}

module.exports = { db, initializeDatabase };
