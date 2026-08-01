// backend/src/request_service.js

/**
 * Shared service functions for request handling
 * Eliminates duplication between api.js, webhook.js, and admin.js
 */

const opReturnCreator = require('./op_return_creator');
const { NO_REFUND_FAILURES } = require('./op_return_creator');
const webhookManager = require('./webhook_manager');
const { attemptRefund } = require('./refund');
const { dbGet, dbRun } = require('./db_utils');
const notifier = require('./notifier');

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
 * @param {boolean} options.autoRefund - Refund the payer once the request is beyond retrying (default: true)
 * @returns {Promise<{success: boolean, opReturnTxId?: string, error?: string, permanent?: boolean, refund?: object}>}
 */
async function fulfillRequest(request, db, rootNode, config, options = {}) {
    const { acquireLock = true, autoRefund = true } = options;
    const requestId = request.id;

    try {
        // Optionally acquire processing lock.
        // lastAttemptAt is stamped here, not just on completion, so the stuck-lock
        // sweeper in reconcile.js can tell a genuinely abandoned lock from one that was
        // taken seconds ago.
        if (acquireLock) {
            const lockResult = await dbRun(
                db,
                `UPDATE requests SET status = 'processing_op_return', lastAttemptAt = ?
                 WHERE id = ? AND status = 'payment_confirmed'`,
                [new Date().toISOString(), requestId]
            );

            if (lockResult.changes === 0) {
                console.log(`[RequestService] Lock not acquired for ${requestId} - already processing or wrong status`);
                return { success: false, error: 'Lock not acquired' };
            }
            console.log(`[RequestService] Lock acquired for ${requestId}`);
        }

        const attemptNumber = (request.attemptCount || 0) + 1;
        let result;
        try {
            result = await opReturnCreator.createOpReturnTransaction(request, rootNode, config.NETWORK, config);
        } catch (opReturnError) {
            console.error(`[RequestService] OP_RETURN creation threw for ${requestId}:`, opReturnError);
            result = { ok: false, reason: 'internal_error', detail: opReturnError.message, permanent: false };
        }

        // --- Success ------------------------------------------------------
        if (result.ok) {
            await dbRun(
                db,
                `UPDATE requests
                 SET status = 'op_return_broadcasted', opReturnTxId = ?, opReturnTxHex = ?,
                     changePath = ?, failureReason = NULL,
                     attemptCount = COALESCE(attemptCount, 0) + 1, lastAttemptAt = ?
                 WHERE id = ?`,
                [result.opReturnTxId, result.signedTxHex, result.changePath || null, new Date().toISOString(), requestId]
            );
            console.log(`[RequestService] Request ${requestId} status updated to op_return_broadcasted`);

            if (request.blockcypherHookId) {
                webhookManager.deleteWebhook(request.blockcypherHookId, config);
            }
            notifier.notifyDelivered({
                requestId,
                message: request.message,
                opReturnTxId: result.opReturnTxId,
            }, config);
            return { success: true, opReturnTxId: result.opReturnTxId };
        }

        // --- Failure ------------------------------------------------------
        // Record why, and how many times we have now tried. A permanent failure or an
        // exhausted attempt budget means no further retry can help, so we refund.
        const exhausted = attemptNumber >= (config.MAX_FULFILL_ATTEMPTS || 3);
        const terminal = result.permanent || exhausted;
        const failureReason = `${result.reason}${result.detail ? `: ${result.detail}` : ''}`;

        // Guarded on opReturnTxId/refundTxId still being NULL so a losing concurrent
        // attempt can never flip an already-delivered or already-refunded request back
        // to failed. attemptCount is incremented in SQL rather than written from the
        // possibly-stale value read into memory.
        await dbRun(
            db,
            `UPDATE requests
             SET status = 'op_return_failed', failureReason = ?,
                 attemptCount = COALESCE(attemptCount, 0) + 1, lastAttemptAt = ?
             WHERE id = ? AND opReturnTxId IS NULL AND refundTxId IS NULL`,
            [failureReason, new Date().toISOString(), requestId]
        );
        console.error(
            `[RequestService] Request ${requestId} failed (attempt ${attemptNumber}, permanent=${!!result.permanent}, terminal=${terminal}): ${failureReason}`
        );

        if (request.blockcypherHookId && terminal) {
            webhookManager.deleteWebhook(request.blockcypherHookId, config);
        }

        let refund;
        // Never auto-refund a failure that means the money has already left the payment
        // address — there is nothing to return, and pretending otherwise would mark a
        // possibly-delivered request as refund_failed and hide it from review.
        const refundable = !NO_REFUND_FAILURES.has(result.reason);
        if (terminal && autoRefund && refundable) {
            // Re-read so the refund sees the status we just wrote.
            const fresh = await dbGet(db, 'SELECT * FROM requests WHERE id = ?', [requestId]);
            if (fresh) {
                refund = await attemptRefund(fresh, db, rootNode, config);
                if (refund.ok) {
                    console.log(`[RequestService] Auto-refunded ${requestId}: ${refund.refundTxId}`);
                } else {
                    console.warn(`[RequestService] Auto-refund not completed for ${requestId}: ${refund.reason}`);
                }
            }
        }

        notifier.notifyFailed({
            requestId,
            message: request.message,
            reason: failureReason,
            amount: request.paymentReceivedSatoshis,
            terminal,
            refund,
        }, config);

        return {
            success: false,
            error: failureReason,
            permanent: !!result.permanent,
            terminal,
            attemptCount: attemptNumber,
            refund,
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
