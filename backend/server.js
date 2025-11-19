// backend/server.js
const express = require('express');
const path = require('path');
const config = require('./src/config');
const { db, initializeDatabase } = require('./src/database');
const { initializeWallet } = require('./src/wallet');
const requestQueue = require('./src/queue');
const { cleanupOldRequests } = require('./src/cleanup');
const createApiRouter = require('./src/routes/api');
const createWebhookRouter = require('./src/routes/webhook');
const createAdminRouter = require('./src/routes/admin');

// --- Initialization ---
initializeDatabase();
const rootNode = initializeWallet();
const app = express();

// --- Middleware ---
app.use(express.json());

// --- Serve Frontend ---
// This serves your main app (index.html, etc.)
app.use(express.static(path.join(__dirname, '../frontend')));
// ✅ THIS IS THE MISSING LINE: It serves your admin panel
app.use('/admin', express.static(path.join(__dirname, '../frontend/admin')));


// --- API Routes ---
const apiRouter = createApiRouter(db, rootNode, config, requestQueue);
const webhookRouter = createWebhookRouter(db, rootNode, config);
const adminRouter = createAdminRouter(db, rootNode, config);

app.use('/api', apiRouter);
app.use('/api/webhook', webhookRouter);
app.use('/api/admin', adminRouter);

// --- Root Route ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// --- Start Server ---
app.listen(config.PORT, () => {
    console.log(`Server listening on port ${config.PORT}`);
    console.log(`View App: http://localhost:${config.PORT}/`);
    console.log(`View Admin Panel: http://localhost:${config.PORT}/admin`);
});

// --- Scheduled Jobs ---
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
cleanupOldRequests(db); // Run once on startup
setInterval(() => cleanupOldRequests(db), CLEANUP_INTERVAL_MS);
console.log(`[Server] Cleanup job scheduled to run every ${CLEANUP_INTERVAL_MS / (1000 * 60 * 60)} hours.`);