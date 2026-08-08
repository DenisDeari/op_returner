// backend/server.js
const express = require('express');
const path = require('path');
const config = require('./src/config');
const { db, initializeDatabase } = require('./src/database');
const { initializeWallet } = require('./src/wallet');
const requestQueue = require('./src/queue');
const { cleanupOldRequests } = require('./src/cleanup');
const { runReconciliation } = require('./src/reconcile');
const { checkPendingConfirmations } = require('./src/confirm_watch');
const eventLog = require('./src/event_log');

// Start capturing warnings and errors before anything else runs, so the admin panel's
// log view includes startup problems too.
eventLog.install();
const createApiRouter = require('./src/routes/api');
const createWebhookRouter = require('./src/routes/webhook');
const createAdminRouter = require('./src/routes/admin');
const createWalletRouter = require('./src/routes/wallet');
const createInternalRouter = require('./src/routes/internal');

// --- Initialization ---
// The HTTP listener and the scheduled jobs both start from this callback, once the
// schema and wallet_state are guaranteed to exist. Binding the port earlier would let a
// request arrive before wallet_state is seeded, which fails address derivation.
initializeDatabase(() => {
    startServer();
    startScheduledJobs();
});
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
const walletRouter = createWalletRouter(db, rootNode, config);
const internalRouter = createInternalRouter(db, rootNode, config);

app.use('/api', apiRouter);
app.use('/api/webhook', webhookRouter);
// Mounted before the general admin router so /api/admin/wallet/* resolves here.
app.use('/api/admin/wallet', walletRouter);
app.use('/api/admin', adminRouter);
app.use('/api/internal', internalRouter);

// --- Root Route ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// --- Start Server ---
let serverStarted = false;
function startServer() {
    if (serverStarted) return;
    serverStarted = true;
    app.listen(config.PORT, () => {
        console.log(`Server listening on port ${config.PORT}`);
        console.log(`API: http://localhost:${config.PORT}/api`);
        console.log(`Admin: http://localhost:${config.PORT}/admin`);
    });
}

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

    // Notices when a published OP_RETURN reaches a block. Read-only and Esplora-only —
    // it moves no money and cannot touch the BlockCypher allowance. Unlike reconcile it
    // is NOT run on startup: nothing depends on it being fresh at boot, and a deploy
    // should not fire a burst of provider requests before the service is even serving.
    const CONFIRM_WATCH_INTERVAL_MS = config.CONFIRM_WATCH_INTERVAL_MS;
    setInterval(() => {
        checkPendingConfirmations(db, config).catch((e) =>
            console.warn(`[ConfirmWatch] Pass failed: ${e.message}`));
    }, CONFIRM_WATCH_INTERVAL_MS);
    console.log(`[Server] Confirmation watch scheduled to run every ${CONFIRM_WATCH_INTERVAL_MS / (1000 * 60)} minutes.`);
}