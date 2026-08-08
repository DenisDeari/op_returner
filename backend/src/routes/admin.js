// backend/src/routes/admin.js
const express = require('express');
const axios = require('axios');
const { dbGet, dbAll, dbRun } = require('../db_utils');
const { deleteRequest, fulfillRequest } = require('../request_service');
const { attemptRefund, OPERATOR_REFUNDABLE_STATUSES } = require('../refund');
const { computeAlerts } = require('../alerts');
const { requireAdmin } = require('./auth');
const eventLog = require('../event_log');
const requestEvents = require('../request_events');
const webhookReconcile = require('../webhook_reconcile');
const wall = require('../wall');

function createAdminRouter(db, rootNode, config) {
    const router = express.Router();

    const protect = requireAdmin(config);

    /**
     * Everything that currently needs a human, plus the recent warning/error log.
     * The alerts come from the database so they survive a restart; the events are an
     * in-memory convenience view of what the server has been saying.
     */
    router.get('/alerts', protect, async (req, res) => {
        try {
            const { alerts, counts } = await computeAlerts(db, config);
            res.status(200).json({
                counts,
                alerts,
                events: eventLog.getEvents(100),
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            console.error('Error computing alerts:', error.message);
            res.status(500).json({ error: 'Failed to compute alerts' });
        }
    });

    router.get('/requests', protect, async (req, res) => {
        try {
            // Archived rows are kept forever, so the panel would fill with abandoned and
            // cancelled orders over time. Hidden by default, still reachable with
            // ?includeArchived=1 — they are retained precisely so they can be studied.
            const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
            const rows = await dbAll(
                db,
                includeArchived
                    ? 'SELECT * FROM requests ORDER BY createdAt DESC'
                    // An archived row that holds money is never hidden, whatever the
                    // filter says — that is the one the operator has to act on.
                    : `SELECT * FROM requests
                       WHERE archivedAt IS NULL
                          OR paymentTxId IS NOT NULL
                          OR paymentReceivedSatoshis IS NOT NULL
                       ORDER BY createdAt DESC`
            );
            res.status(200).json(rows);
        } catch (error) {
            res.status(500).json({ error: 'Failed to retrieve requests' });
        }
    });

    // The durable history of one request. Unlike event_log.js — an in-memory ring buffer
    // wiped on restart — this survives, and it is the reason archived rows are worth
    // keeping: the row says what was asked for, this says what happened to it.
    router.get('/requests/:requestId/events', protect, async (req, res) => {
        try {
            const events = await requestEvents.forRequest(db, req.params.requestId);
            res.status(200).json(events);
        } catch (error) {
            res.status(500).json({ error: 'Failed to retrieve request history' });
        }
    });

    /**
     * What is actually registered at BlockCypher, reconciled against the database.
     *
     * The judgement lives in webhook_reconcile.js, shared with the scheduled sweep in
     * cleanup.js so the manual and automatic views can never disagree about what is waste.
     *
     * Read-only. Deleting is a separate, deliberate POST.
     */
    router.get('/webhooks', protect, async (req, res) => {
        try {
            const result = await webhookReconcile.reconcileWebhooks(db, config);
            if (!result.ok) return res.status(502).json({ error: `Could not list webhooks: ${result.reason}` });
            res.status(200).json(result);
        } catch (error) {
            console.error('Error listing webhooks:', error.message);
            res.status(500).json({ error: 'Failed to list webhooks' });
        }
    });

    /**
     * Deletes every hook the reconciliation above calls orphaned. Deliberate and explicit:
     * it never touches a hook a live request still depends on, and it re-derives that
     * judgement here rather than trusting anything the caller sends.
     */
    router.post('/webhooks/prune', protect, async (req, res) => {
        try {
            // An operator asked for this and is waiting on the answer, so there is no
            // per-pass cap — but the rate-limit stop still applies, and `remaining` says
            // plainly how many are left rather than reporting a cleanup that did not land.
            const results = await webhookReconcile.pruneOrphanedWebhooks(db, config, { limit: Infinity });
            if (results.ok === false) return res.status(502).json({ error: `Could not list webhooks: ${results.reason}` });

            console.log(`[Admin] Webhook prune: deleted ${results.deleted}, already gone ${results.alreadyGone}, `
                + `still in use ${results.skipped}, failed ${results.failed}, remaining ${results.remaining}.`);
            res.status(200).json(results);
        } catch (error) {
            console.error('Error pruning webhooks:', error.message);
            res.status(500).json({ error: 'Failed to prune webhooks' });
        }
    });

    router.post('/config/limits', protect, (req, res) => {
        const { maxPayloadSize } = req.body;
        if (!maxPayloadSize || isNaN(maxPayloadSize)) {
            return res.status(400).json({ error: 'Invalid maxPayloadSize' });
        }
        db.run("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('max_payload_size', ?)", [maxPayloadSize.toString()], (err) => {
            if (err) {
                console.error("Error updating max_payload_size:", err);
                return res.status(500).json({ error: 'Failed to update limit' });
            }
            res.json({ success: true, maxPayloadSize });
        });
    });

    router.get('/address-transactions/:address', protect, async (req, res) => {
        const { address } = req.params;
        try {
            const apiUrl = `${config.BLOCKCYPHER_API_BASE}/addrs/${address}/full?token=${config.BLOCKCYPHER_TOKEN}`;
            const response = await axios.get(apiUrl);
            res.status(200).json(response.data);
        } catch (error) {
            console.error(`Error fetching address details for ${address}:`, error.message);
            if (error.response) {
                res.status(error.response.status).json(error.response.data);
            } else {
                res.status(500).json({ error: 'Failed to fetch address transactions' });
            }
        }
    });

    router.post('/fulfill/:requestId', protect, async (req, res) => {
        const { requestId } = req.params;
        try {
            const request = await dbGet(db, "SELECT * FROM requests WHERE id = ?", [requestId]);
            if (!request) {
                return res.status(404).json({ error: 'Request not found.' });
            }
            if (request.opReturnTxId) {
                return res.status(409).json({ error: 'Request has already been broadcast.' });
            }
            if (request.refundTxId) {
                return res.status(409).json({ error: 'Request has already been refunded — cannot fulfil it now.' });
            }
            // A refund in flight is spending the same UTXO. Forcing a fulfilment now
            // would race it, and both would try to spend the customer's payment.
            if (request.status === 'refund_processing') {
                return res.status(409).json({ error: 'A refund is currently in progress for this request. Try again once it settles.' });
            }

            // An archived row is one the customer cancelled, or one abandoned unpaid for a
            // week. Publishing it is publishing a message that was withdrawn — and it is
            // reachable, because a payment can still arrive at an archived address and
            // cleanup records it (recordUnexpectedPayment) without changing `status`.
            //
            // Not forbidden: delivering what a late payer paid for is sometimes exactly
            // right. But it must be a decision somebody makes on purpose, so it needs
            // saying twice. This is also what keeps the automatic machinery out of it —
            // once a forced attempt fails, the row becomes an ordinary retry candidate for
            // reconcile.js, which is how a withdrawn message could otherwise get published
            // by a scheduled job with no human in the loop at all.
            const { confirmArchived } = req.body || {};
            if (request.archivedAt && confirmArchived !== true) {
                return res.status(409).json({
                    error: request.archivedReason === 'cancelled_by_customer'
                        ? 'This request was CANCELLED by the customer. Publishing it now would put a withdrawn message on-chain. Re-send with confirmArchived to override.'
                        : 'This request was archived as abandoned. Re-send with confirmArchived to override.',
                    archivedAt: request.archivedAt,
                    archivedReason: request.archivedReason,
                    needsConfirmation: 'confirmArchived',
                });
            }
            if (request.archivedAt) {
                console.warn(`[Admin] Forcing fulfilment of ARCHIVED request ${requestId} (${request.archivedReason}) — operator confirmed.`);
                requestEvents.record(db, requestId, requestEvents.KINDS.FULFIL_ATTEMPT,
                    `operator forced fulfilment of an archived request (${request.archivedReason})`);
            }

            // Claim the request so the automatic path cannot pick it up concurrently.
            // The operator is deliberately forcing this, so any non-final status is
            // allowed, but the claim itself is still conditional.
            const claim = await dbRun(
                db,
                `UPDATE requests SET status = 'processing_op_return', lastAttemptAt = ?
                 WHERE id = ? AND opReturnTxId IS NULL AND refundTxId IS NULL
                   AND status NOT IN ('refund_processing', 'refunded')`,
                [new Date().toISOString(), requestId]
            );
            if (claim.changes === 0) {
                return res.status(409).json({ error: 'Could not claim the request — its state changed. Refresh and retry.' });
            }

            // Route through the shared service so status, failureReason and attempt
            // accounting are recorded identically to the automatic path. The lock is
            // skipped because we just claimed it above, and auto-refund is off so a
            // manual attempt never silently moves the customer's money.
            const result = await fulfillRequest({ ...request, status: 'processing_op_return' }, db, rootNode, config, {
                acquireLock: false,
                autoRefund: false,
            });

            if (result.success) {
                res.status(200).json({ success: true, txId: result.opReturnTxId });
            } else {
                res.status(500).json({ error: result.error || 'Failed to create OP_RETURN transaction.' });
            }
        } catch (error) {
            console.error(`Manual fulfillment failed for ${requestId}:`, error);
            res.status(500).json({ error: 'An error occurred during manual fulfillment.' });
        }
    });

    /**
     * POST /api/admin/requests/:requestId/visibility  { hidden: true|false }
     *
     * Takes a message off the public wall, or puts it back.
     *
     * Writes `hiddenByAdmin` and never touches `isPublic`: the customer's choice is theirs,
     * and keeping the two separate means un-hiding restores what they actually asked for
     * instead of guessing. A message the customer never opted in to cannot be "shown" here.
     *
     * The message stays on-chain regardless — that is what they paid for and it is not
     * ours to remove. This governs one thing: whether satwire.io repeats it.
     */
    router.post('/requests/:requestId/visibility', protect, async (req, res) => {
        const { requestId } = req.params;
        const { hidden } = req.body || {};

        try {
            if (typeof hidden !== 'boolean') {
                return res.status(400).json({ error: 'hidden must be true or false.' });
            }

            const row = await dbGet(
                db,
                'SELECT id, status, isPublic, hiddenByAdmin FROM requests WHERE id = ?',
                [requestId]
            );
            if (!row) {
                return res.status(404).json({ error: 'Request not found.' });
            }
            if (!row.isPublic) {
                return res.status(409).json({ error: 'This customer did not choose to show this message, so it is not on the wall.' });
            }

            // Conditional UPDATE as the write, per the house pattern: idempotent, and
            // immune to the row changing between the read above and this statement.
            const flip = await dbRun(
                db,
                'UPDATE requests SET hiddenByAdmin = ? WHERE id = ? AND isPublic = 1',
                [hidden ? 1 : 0, requestId]
            );
            if (flip.changes === 0) {
                return res.status(409).json({ error: 'Could not update — the request changed. Refresh and retry.' });
            }

            // Moderation must be visible immediately, so this is the one caller that
            // cannot wait out the wall's 10-second cache.
            wall.invalidate();

            requestEvents.record(
                db, requestId,
                hidden ? requestEvents.KINDS.WALL_HIDDEN : requestEvents.KINDS.WALL_SHOWN,
                hidden ? 'hidden from the public wall by the operator' : 'restored to the public wall by the operator'
            );
            console.log(`[Admin] Wall visibility for ${requestId}: ${hidden ? 'hidden' : 'shown'}.`);

            res.status(200).json({ success: true, requestId, hiddenByAdmin: hidden });
        } catch (error) {
            console.error(`Failed to set wall visibility for ${requestId}:`, error.message);
            res.status(500).json({ error: 'Failed to update visibility.' });
        }
    });

    router.post('/refund/:requestId', protect, async (req, res) => {
        const { requestId } = req.params;
        try {
            const request = await dbGet(db, "SELECT * FROM requests WHERE id = ?", [requestId]);
            if (!request) {
                return res.status(404).json({ error: 'Request not found.' });
            }

            // An operator may refund from a wider set of statuses than the automatic
            // path allows — in particular an underpaid request, which holds real money
            // but never reaches a failed state by itself.
            const result = await attemptRefund(request, db, rootNode, config, {
                allowStatuses: OPERATOR_REFUNDABLE_STATUSES,
            });
            if (result.ok) {
                res.status(200).json({ success: true, refundTxId: result.refundTxId, amount: result.amount });
            } else {
                res.status(400).json({ error: result.reason });
            }
        } catch (error) {
            console.error(`Manual refund failed for ${requestId}:`, error);
            res.status(500).json({ error: 'An error occurred during the refund.' });
        }
    });

    router.delete('/requests/:requestId', protect, async (req, res) => {
        const { requestId } = req.params;
        console.log(`Admin deleting request: ${requestId}`);
        try {
            const result = await deleteRequest(requestId, db, config);
            if (!result.success) {
                return res.status(404).json({ error: result.error || 'Request not found' });
            }
            res.status(200).json({ success: true, message: 'Request deleted successfully' });
        } catch (error) {
            console.error(`Error deleting request ${requestId}:`, error);
            res.status(500).json({ error: 'Failed to delete request' });
        }
    });

    return router;
}

module.exports = createAdminRouter;