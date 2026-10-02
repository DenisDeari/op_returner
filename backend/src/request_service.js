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
const events = require('./request_events');
const lightning = require('./lightning');
const { isNoRefundReason } = require('./failure_reasons');

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
        events.record(db, requestId, events.KINDS.FULFIL_ATTEMPT, `attempt ${attemptNumber}`);
        let result;
        try {
            // A Lightning payment left no UTXO to spend, so the treasury pays for the
            // transaction instead. Both builders return the same shape; everything below
            // records them identically.
            result = lightning.isLightningRow(request)
                ? await lightning.fulfilLightning(request, db, rootNode, config)
                : await opReturnCreator.createOpReturnTransaction(request, rootNode, config.NETWORK, config);
        } catch (opReturnError) {
            console.error(`[RequestService] OP_RETURN creation threw for ${requestId}:`, opReturnError);
            result = { ok: false, reason: 'internal_error', detail: opReturnError.message, permanent: false };
        }

        // Another live worker in this process is already publishing this order (a lock
        // reconcile released while that worker sat queued behind the treasury lock). That is
        // not a failure of the order: record nothing, leave the row to the worker that holds
        // it, exactly as for "Lock not acquired". Writing a failure here burned attempts and
        // flipped the status under the live worker, which then refused to broadcast.
        if (result && result.reason === 'fulfilment_in_progress') {
            console.log(`[RequestService] ${requestId} is already being published by another worker; leaving it to that one.`);
            return { success: false, error: 'Lock not acquired' };
        }

        // --- Success ------------------------------------------------------
        if (result.ok) {
            await dbRun(
                db,
                `UPDATE requests
                 SET status = 'op_return_broadcasted', opReturnTxId = ?, opReturnTxHex = ?,
                     changePath = ?, failureReason = NULL, pendingTxId = NULL, pendingTxHex = NULL,
                     attemptCount = COALESCE(attemptCount, 0) + 1, lastAttemptAt = ?
                 WHERE id = ?`,
                [result.opReturnTxId, result.signedTxHex, result.changePath || null, new Date().toISOString(), requestId]
            );
            console.log(`[RequestService] Request ${requestId} status updated to op_return_broadcasted`);
            events.record(db, requestId, events.KINDS.PUBLISHED, `attempt ${attemptNumber}, tx ${result.opReturnTxId}`);

            if (request.blockcypherHookId) {
                webhookManager.deleteWebhook(request.blockcypherHookId, config);
            }
            notifier.notifyDelivered({
                requestId,
                message: request.message,
                payloadKind: request.payloadKind,
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
        events.record(db, requestId, events.KINDS.FULFIL_FAILED, `attempt ${attemptNumber}, terminal=${terminal}: ${failureReason}`);

        if (request.blockcypherHookId && terminal) {
            webhookManager.deleteWebhook(request.blockcypherHookId, config);
        }

        let refund;
        // Never auto-refund a failure that means the money has already left the payment
        // address — there is nothing to return, and pretending otherwise would mark a
        // possibly-delivered request as refund_failed and hide it from review.
        // isNoRefundReason also covers a Lightning order whose treasury transaction may
        // already be on chain (treasury_tx_unresolved).
        const refundable = !NO_REFUND_FAILURES.has(result.reason) && !isNoRefundReason(result.reason);
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
            payloadKind: request.payloadKind,
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
        const row = await dbGet(
            db,
            "SELECT blockcypherHookId, archivedAt FROM requests WHERE id = ?",
            [requestId]
        );

        if (!row) {
            return { success: false, error: 'Request not found' };
        }
        if (row.archivedAt) {
            // Already cancelled. Idempotent so a double-click is not an error.
            return { success: true };
        }

        // Archived, never deleted. The row is the only record of what this customer asked
        // for and which address they were quoted, and a cancel used to destroy it — so a
        // payment landing in the gap between the caller's payment check and the DELETE
        // left money at an address with nothing to explain it. Marking the row instead
        // makes that race harmless: the worst case is an archived row that holds funds,
        // which alerts.js and reconcile's stranded report both surface because they key on
        // payment alone.
        //
        // The money guards are carried into the write, so this cannot claim a row that
        // acquired a payment since the caller checked.
        const claim = await dbRun(
            db,
            `UPDATE requests
             SET archivedAt = ?, archivedReason = 'cancelled_by_customer'
             WHERE id = ?
               AND archivedAt IS NULL
               AND paymentTxId IS NULL
               AND paymentReceivedSatoshis IS NULL
               AND opReturnTxId IS NULL
               AND refundTxId IS NULL`,
            [new Date().toISOString(), requestId]
        );

        if (claim.changes !== 1) {
            return { success: false, error: 'This request has an associated payment and cannot be cancelled.' };
        }

        // Only once the row is claimed. Stopping the watch on a row we failed to claim
        // would leave a paying customer unwatched.
        if (row.blockcypherHookId) {
            webhookManager.deleteWebhook(row.blockcypherHookId, config);
            await dbRun(db, 'UPDATE requests SET webhooksRetiredAt = ? WHERE id = ? AND webhooksRetiredAt IS NULL',
                [new Date().toISOString(), requestId]);
        }
        events.record(db, requestId, events.KINDS.CANCELLED, 'cancelled by customer, archived');
        console.log(`[RequestService] Request ${requestId} cancelled by customer and archived`);

        return { success: true };

    } catch (error) {
        console.error(`[RequestService] Error cancelling request ${requestId}:`, error);
        return { success: false, error: error.message };
    }
}

module.exports = { fulfillRequest, deleteRequest };
