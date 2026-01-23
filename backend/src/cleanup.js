const webhookManager = require('./webhook_manager');
const config = require('./config');
const { dbAll, dbRun } = require('./db_utils');

/**
 * Deletes old, abandoned requests from the database to keep it clean.
 * @param {object} db - The SQLite database connection object.
 */
async function cleanupOldRequests(db) {
    // Calculate the timestamp for 48 hours ago.
    // The format matches how SQLite stores dates (e.g., 'YYYY-MM-DD HH:MM:SS.SSS').
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    console.log(`[Cleanup] Running job to delete pending requests older than ${fortyEightHoursAgo}...`);

    try {
        // Find the requests to be deleted to clean up their webhooks
        const rows = await dbAll(
            db,
            "SELECT blockcypherHookId FROM requests WHERE status = 'pending_payment' AND createdAt < ?",
            [fortyEightHoursAgo]
        );

        if (rows.length > 0) {
            console.log(`[Cleanup] Found ${rows.length} requests to clean up.`);
            
            // Delete associated webhooks
            for (const row of rows) {
                if (row.blockcypherHookId) {
                    webhookManager.deleteWebhook(row.blockcypherHookId, config);
                }
            }

            // Delete the requests
            const result = await dbRun(
                db,
                "DELETE FROM requests WHERE status = 'pending_payment' AND createdAt < ?",
                [fortyEightHoursAgo]
            );
            
            console.log(`[Cleanup] Successfully deleted ${result.changes} old, pending requests.`);
        } else {
            console.log('[Cleanup] No old, pending requests to delete.');
        }
    } catch (error) {
        console.error('[Cleanup] Error during cleanup:', error.message);
    }
}

module.exports = { cleanupOldRequests };