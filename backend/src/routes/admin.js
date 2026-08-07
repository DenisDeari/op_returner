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
const webhookManager = require('../webhook_manager');

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
     * A hook is "orphaned" when nothing in `requests` still needs it: either no row claims
     * its id at all (the row was hard-deleted before archiving existed, and the unawaited
     * delete that fired may never have landed), or the row that claims it has already been
     * retired, archived or settled. Those are pure waste against a free-tier allowance the
     * payment path depends on.
     *
     * Read-only. Deleting is a separate, deliberate POST.
     */
    router.get('/webhooks', protect, async (req, res) => {
        try {
            const listed = await webhookManager.listWebhooks(config);
            if (!listed.ok) return res.status(502).json({ error: `Could not list webhooks: ${listed.reason}` });

            const rows = await dbAll(db, `SELECT id, address, status, blockcypherHookId, webhooksRetiredAt,
                                                 archivedAt, opReturnTxId, refundTxId FROM requests
                                          WHERE blockcypherHookId IS NOT NULL`);
            // hookId -> the request that registered it
            const owner = new Map();
            for (const r of rows) {
                for (const hookId of String(r.blockcypherHookId).split(',')) owner.set(hookId.trim(), r);
            }

            const annotated = listed.hooks.map((h) => {
                const r = owner.get(h.id);
                const stillNeeded = !!r
                    && !r.webhooksRetiredAt && !r.archivedAt && !r.opReturnTxId && !r.refundTxId;
                return {
                    ...h,
                    requestId: r ? r.id : null,
                    requestStatus: r ? r.status : null,
                    reason: !r ? 'no request claims this hook'
                        : stillNeeded ? 'in use'
                        : r.webhooksRetiredAt ? 'request already retired'
                        : r.archivedAt ? 'request archived'
                        : 'request already settled',
                    orphaned: !stillNeeded,
                };
            });

            res.status(200).json({
                total: annotated.length,
                inUse: annotated.filter((h) => !h.orphaned).length,
                orphaned: annotated.filter((h) => h.orphaned).length,
                hooks: annotated,
            });
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
            const listed = await webhookManager.listWebhooks(config);
            if (!listed.ok) return res.status(502).json({ error: `Could not list webhooks: ${listed.reason}` });

            const rows = await dbAll(db, `SELECT id, blockcypherHookId, webhooksRetiredAt, archivedAt,
                                                 opReturnTxId, refundTxId FROM requests
                                          WHERE blockcypherHookId IS NOT NULL`);
            const owner = new Map();
            for (const r of rows) {
                for (const hookId of String(r.blockcypherHookId).split(',')) owner.set(hookId.trim(), r);
            }

            const results = { deleted: 0, alreadyGone: 0, failed: 0, skipped: 0, errors: [] };
            for (const hook of listed.hooks) {
                const r = owner.get(hook.id);
                const stillNeeded = !!r
                    && !r.webhooksRetiredAt && !r.archivedAt && !r.opReturnTxId && !r.refundTxId;
                if (stillNeeded) { results.skipped++; continue; }

                const out = await webhookManager.deleteWebhookById(hook.id, config);
                if (out.ok && out.alreadyGone) results.alreadyGone++;
                else if (out.ok) results.deleted++;
                else { results.failed++; results.errors.push(`${hook.id}: ${out.reason}`); }
            }

            console.log(`[Admin] Webhook prune: deleted ${results.deleted}, already gone ${results.alreadyGone}, `
                + `still in use ${results.skipped}, failed ${results.failed}.`);
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