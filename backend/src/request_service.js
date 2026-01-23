// backend/src/request_service.js

/**
 * Shared service functions for request handling
 * Eliminates duplication between api.js, webhook.js, and admin.js
 */

const opReturnCreator = require('./op_return_creator');
const webhookManager = require('./webhook_manager');
const { dbGet, dbRun } = require('./db_utils');

/**
 * Attempts to fulfill a request by creating and broadcasting an OP_RETURN transaction.
 * Handles locking, status updates, and webhook cleanup.
 * 
 * @param {object} request - The request object from the database
 * @param {object} db - SQLite database connection
 * @param {object} rootNode - HD wallet root node
 * @param {object} config - Application config
 * @param {object} options - Additional options
 * @param {boolean} options.acquireLock - Whether to acquire processing lock (default: true)
 * @returns {Promise<{success: boolean, opReturnTxId?: string, error?: string}>}
 */
async function fulfillRequest(request, db, rootNode, config, options = {}) {
    const { acquireLock = true } = options;
    const requestId = request.id;

    try {
        // Optionally acquire processing lock
        if (acquireLock) {
            const lockResult = await dbRun(
                db,
                "UPDATE requests SET status = 'processing_op_return' WHERE id = ? AND status = 'payment_confirmed'",
                [requestId]
            );
            
            if (lockResult.changes === 0) {
                console.log(`[RequestService] Lock not acquired for ${requestId} - already processing or wrong status`);
                return { success: false, error: 'Lock not acquired' };
            }
            console.log(`[RequestService] Lock acquired for ${requestId}`);
        }

        // Create and broadcast OP_RETURN transaction
        let finalStatus = 'op_return_failed';
        let opReturnResult = null;

        try {
            opReturnResult = await opReturnCreator.createOpReturnTransaction(
                request,
                rootNode,
                config.NETWORK,
                {
                    BLOCKCYPHER_API_BASE: config.BLOCKCYPHER_API_BASE,
                    BLOCKCYPHER_TOKEN: config.BLOCKCYPHER_TOKEN
                }
            );

            if (opReturnResult && opReturnResult.opReturnTxId) {
                finalStatus = 'op_return_broadcasted';
            }
        } catch (opReturnError) {
            console.error(`[RequestService] OP_RETURN creation error for ${requestId}:`, opReturnError);
        }

        // Update database with result
        await dbRun(
            db,
            "UPDATE requests SET status = ?, opReturnTxId = ?, opReturnTxHex = ? WHERE id = ?",
            [finalStatus, opReturnResult?.opReturnTxId, opReturnResult?.signedTxHex, requestId]
        );
        console.log(`[RequestService] Request ${requestId} status updated to ${finalStatus}`);

        // Cleanup webhook after completion
        if (request.blockcypherHookId) {
            webhookManager.deleteWebhook(request.blockcypherHookId, config);
        }

        return {
            success: finalStatus === 'op_return_broadcasted',
            opReturnTxId: opReturnResult?.opReturnTxId,
            error: finalStatus === 'op_return_failed' ? 'OP_RETURN creation failed' : undefined
        };

    } catch (error) {
        console.error(`[RequestService] Error fulfilling request ${requestId}:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * Deletes a request and cleans up associated webhooks.
 * 
 * @param {string} requestId - The request ID to delete
 * @param {object} db - SQLite database connection
 * @param {object} config - Application config
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteRequest(requestId, db, config) {
    try {
        // Get webhook ID before deleting
        const row = await dbGet(
            db,
            "SELECT blockcypherHookId FROM requests WHERE id = ?",
            [requestId]
        );

        if (!row) {
            return { success: false, error: 'Request not found' };
        }

        // Delete associated webhook
        if (row.blockcypherHookId) {
            webhookManager.deleteWebhook(row.blockcypherHookId, config);
        }

        // Delete the request
        await dbRun(db, "DELETE FROM requests WHERE id = ?", [requestId]);
        console.log(`[RequestService] Request ${requestId} deleted successfully`);

        return { success: true };

    } catch (error) {
        console.error(`[RequestService] Error deleting request ${requestId}:`, error);
        return { success: false, error: error.message };
    }
}

module.exports = { fulfillRequest, deleteRequest };
