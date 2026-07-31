// backend/server.js
const express = require('express');
const path = require('path');
const config = require('./src/config');
const { db, initializeDatabase } = require('./src/database');
const { initializeWallet } = require('./src/wallet');
const requestQueue = require('./src/queue');
const { cleanupOldRequests } = require('./src/cleanup');
const { runReconciliation } = require('./src/reconcile');
const createApiRouter = require('./src/routes/api');
const createWebhookRouter = require('./src/routes/webhook');
const createAdminRouter = require('./src/routes/admin');
const createInternalRouter = require('./src/routes/internal');

// --- Initialization ---
// Scheduled jobs are started from this callback, once the schema is guaranteed to exist.
initializeDatabase(() => startScheduledJobs());
const rootNode = initializeWallet();
const app = express();

// --- Middleware ---
app.use(express.json());

// --- Serve Frontend ---
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/admin', express.static(path.join(__dirname, '../frontend/admin')));

// --- API Routes ---
const apiRouter = createApiRouter(db, rootNode, config, requestQueue);
const webhookRouter = createWebhookRouter(db, rootNode, config);
const adminRouter = createAdminRouter(db, rootNode, config);
const internalRouter = createInternalRouter(db, rootNode, config);

app.use('/api', apiRouter);
app.use('/api/webhook', webhookRouter);
app.use('/api/admin', adminRouter);
app.use('/api/internal', internalRouter);

// --- Root Route ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// --- Start Server ---
app.listen(config.PORT, () => {
    console.log(`Server listening on port ${config.PORT}`);
    console.log(`API: http://localhost:${config.PORT}/api`);
    console.log(`Admin: http://localhost:${config.PORT}/admin`);
});

// --- Scheduled Jobs ---
// Called from the initializeDatabase ready callback so no job ever queries a table or
// column that has not been created yet.
let scheduledJobsStarted = false;
function startScheduledJobs() {
    if (scheduledJobsStarted) return;
    scheduledJobsStarted = true;

    const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
    cleanupOldRequests(db); // Run once on startup
    setInterval(() => cleanupOldRequests(db), CLEANUP_INTERVAL_MS);
    console.log(`[Server] Cleanup job scheduled to run every ${CLEANUP_INTERVAL_MS / (1000 * 60 * 60)} hours.`);

    // Reconciliation retries dropped fulfilments, refunds terminal failures, and reports
    // any request still holding customer funds. Runs on startup so a restart immediately
    // picks up whatever was in flight when the process last stopped.
    const RECONCILE_INTERVAL_MS = config.RECONCILE_INTERVAL_MS;
    runReconciliation(db, rootNode, config);
    setInterval(() => runReconciliation(db, rootNode, config), RECONCILE_INTERVAL_MS);
    console.log(`[Server] Reconciliation job scheduled to run every ${RECONCILE_INTERVAL_MS / (1000 * 60)} minutes.`);
}