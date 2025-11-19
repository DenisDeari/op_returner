/**
 * Deletes old, abandoned requests from the database to keep it clean.
 * @param {object} db - The SQLite database connection object.
 */
function cleanupOldRequests(db) {
    // Calculate the timestamp for 48 hours ago.
    // The format matches how SQLite stores dates (e.g., 'YYYY-MM-DD HH:MM:SS.SSS').
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    console.log(`[Cleanup] Running job to delete pending requests older than ${fortyEightHoursAgo}...`);

    const sql = `DELETE FROM requests WHERE status = 'pending_payment' AND createdAt < ?`;

    db.run(sql, [fortyEightHoursAgo], function(err) {
        if (err) {
            console.error('[Cleanup] Error deleting old requests:', err.message);
        } else {
            if (this.changes > 0) {
                console.log(`[Cleanup] Successfully deleted ${this.changes} old, pending requests.`);
            } else {
                console.log('[Cleanup] No old, pending requests to delete.');
            }
        }
    });
}

module.exports = { cleanupOldRequests };