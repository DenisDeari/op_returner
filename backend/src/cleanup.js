const webhookManager = require('./webhook_manager');
const config = require('./config');

/**
 * Deletes old, abandoned requests from the database to keep it clean.
 * @param {object} db - The SQLite database connection object.
 */
function cleanupOldRequests(db) {
    // Calculate the timestamp for 48 hours ago.
    // The format matches how SQLite stores dates (e.g., 'YYYY-MM-DD HH:MM:SS.SSS').
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    console.log(`[Cleanup] Running job to delete pending requests older than ${fortyEightHoursAgo}...`);

    // First, find the requests to be deleted to clean up their webhooks
    db.all("SELECT blockcypherHookId FROM requests WHERE status = 'pending_payment' AND createdAt < ?", [fortyEightHoursAgo], (err, rows) => {
        if (err) {
            console.error('[Cleanup] Error finding old requests:', err.message);
            return;
        }

        if (rows.length > 0) {
            console.log(`[Cleanup] Found ${rows.length} requests to clean up.`);
            rows.forEach(row => {
                if (row.blockcypherHookId) {
                    webhookManager.deleteWebhook(row.blockcypherHookId, config);
                }
            });

            // Now delete them
            const sql = `DELETE FROM requests WHERE status = 'pending_payment' AND createdAt < ?`;
            db.run(sql, [fortyEightHoursAgo], function(err) {
                if (err) {
                    console.error('[Cleanup] Error deleting old requests:', err.message);
                } else {
                    console.log(`[Cleanup] Successfully deleted ${this.changes} old, pending requests.`);
                }
            });
        } else {
            console.log('[Cleanup] No old, pending requests to delete.');
        }
    });
}

module.exports = { cleanupOldRequests };