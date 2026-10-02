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
const counters = require('../counters');
const { MAX_ON_CHAIN_PAYLOAD_BYTES } = require('../op_return_creator');
const lightning = require('../lightning');
const treasury = require('../treasury');
const chainProviders = require('../chain_providers');
const notifier = require('../notifier');

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

    /**
     * GET /api/admin/funnel?days=30 — the drop-off, day by day.
     *
     * Four numbers per day, and the only one that is new is the first:
     *
     *   visits    homepage renders           (daily_counters, server-side)
     *   quotes    requests created           (requests.createdAt — a customer who has
     *                                         seen the full price and clicked through)
     *   payOpened payment panel opened       (daily_counters, client beacon)
     *   copied    address copied             (daily_counters, client beacon)
     *   paid      requests that were paid    (requests.paymentTxId)
     *
     * visits→quotes is the composer's conversion; quotes→paid is the one that has been
     * losing two of every three orders with no explanation, and copied→paid is what tells
     * those two apart — someone who copied the address and never paid changed their mind
     * or could not pay, which is a different fix from someone who never opened the panel.
     *
     * The two beacon columns are approximate and forgeable by anyone who can POST; the
     * two from `requests` are exact. Do not mix them in one number.
     */
    router.get('/funnel', protect, async (req, res) => {
        try {
            const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
            const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

            const [counted, rows] = await Promise.all([
                counters.read(db, days),
                dbAll(db, `
                    SELECT substr(createdAt, 1, 10) AS day,
                           COUNT(*) AS quotes,
                           SUM(CASE WHEN paymentTxId IS NOT NULL THEN 1 ELSE 0 END) AS paid
                      FROM requests
                     WHERE substr(createdAt, 1, 10) >= ?
                     GROUP BY day
                `, [since]),
            ]);

            const byDay = new Map();
            const at = (day) => {
                if (!byDay.has(day)) {
                    byDay.set(day, { day, visits: 0, quotes: 0, payOpened: 0, copied: 0, paid: 0 });
                }
                return byDay.get(day);
            };
            for (const { day, counts } of counted) {
                const d = at(day);
                d.visits = counts[counters.EVENTS.HOME_VIEW] || 0;
                d.payOpened = counts[counters.EVENTS.PAY_OPENED] || 0;
                d.copied = counts[counters.EVENTS.ADDRESS_COPIED] || 0;
            }
            for (const r of rows || []) {
                const d = at(r.day);
                d.quotes = r.quotes || 0;
                d.paid = r.paid || 0;
            }

            const series = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
            const totals = series.reduce((acc, d) => ({
                visits: acc.visits + d.visits,
                quotes: acc.quotes + d.quotes,
                payOpened: acc.payOpened + d.payOpened,
                copied: acc.copied + d.copied,
                paid: acc.paid + d.paid,
            }), { visits: 0, quotes: 0, payOpened: 0, copied: 0, paid: 0 });

            res.status(200).json({ days, totals, series, generatedAt: new Date().toISOString() });
        } catch (error) {
            console.error('Error computing funnel:', error.message);
            res.status(500).json({ error: 'Failed to compute funnel' });
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

    // Both payload ceilings, in ON-CHAIN bytes. Either may be sent on its own.
    //
    // The hard ceiling is op_return_creator.js's MAX_ON_CHAIN_PAYLOAD_BYTES: a value above
    // it would be accepted here, quoted to a customer, and then refused by the builder
    // after they had already paid. That is the exact shape of the failure this service
    // exists not to repeat, so it is clamped rather than trusted.
    router.post('/config/limits', protect, (req, res) => {
        const { maxPayloadSize, maxImagePayloadSize } = req.body;

        const updates = [];
        const parse = (value, label) => {
            const n = Number(value);
            if (!Number.isInteger(n) || n < 0) return `${label} must be a non-negative integer number of bytes.`;
            if (n > MAX_ON_CHAIN_PAYLOAD_BYTES) {
                return `${label} cannot exceed ${MAX_ON_CHAIN_PAYLOAD_BYTES}, the builder's own ceiling — anything above it would be quoted and then refused after payment.`;
            }
            return null;
        };

        if (maxPayloadSize !== undefined) {
            const err = parse(maxPayloadSize, 'maxPayloadSize');
            if (err) return res.status(400).json({ error: err });
            updates.push(['max_payload_size', String(Number(maxPayloadSize))]);
        }
        if (maxImagePayloadSize !== undefined) {
            const err = parse(maxImagePayloadSize, 'maxImagePayloadSize');
            if (err) return res.status(400).json({ error: err });
            // 0 is meaningful: it turns image payloads off without a deploy.
            updates.push(['max_image_payload_size', String(Number(maxImagePayloadSize))]);
        }
        if (!updates.length) {
            return res.status(400).json({ error: 'Send maxPayloadSize and/or maxImagePayloadSize.' });
        }

        let pending = updates.length;
        let failed = false;
        for (const [key, value] of updates) {
            db.run('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)', [key, value], (err) => {
                if (err && !failed) {
                    failed = true;
                    console.error(`Error updating ${key}:`, err);
                    return res.status(500).json({ error: 'Failed to update limit' });
                }
                if (--pending === 0 && !failed) {
                    console.log(`[Admin] Payload limits updated: ${updates.map(([k, v]) => `${k}=${v}`).join(', ')}`);
                    res.json({ success: true, updated: Object.fromEntries(updates) });
                }
            });
        }
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

            // The last attempt to pay this refund may have gone through: phoenixd could
            // not say. Paying again is the operator's call, and it needs saying twice.
            if (lightning.isLightningRow(request)
                && /^ln_refund_outcome_unknown/.test(request.refundFailureReason || '')
                && (req.body || {}).confirmUnknownOutcome !== true) {
                return res.status(409).json({
                    error: 'The last refund attempt for this order has an UNKNOWN outcome — it may already have been paid. '
                        + "Check phoenixd's outgoing payments first. Re-send with confirmUnknownOutcome to pay again anyway.",
                    needsConfirmation: 'confirmUnknownOutcome',
                });
            }

            // A Lightning order is refunded to a Lightning address. The operator may supply
            // one (a customer who wrote in by email, say), and it replaces the customer's
            // only under the same guards the customer's own form has.
            const { lightningAddress } = req.body || {};
            if (lightning.isLightningRow(request) && lightningAddress !== undefined) {
                const normalized = lightning.normalizeLightningAddress(lightningAddress);
                if (!normalized.ok) return res.status(400).json({ error: normalized.error });
                const write = await dbRun(
                    db,
                    `UPDATE requests SET lnRefundAddress = ?
                     WHERE id = ? AND opReturnTxId IS NULL AND refundTxId IS NULL AND status != 'refund_processing'`,
                    [normalized.address, requestId]
                );
                if (write.changes !== 1) return res.status(409).json({ error: 'The request changed state. Refresh and retry.' });
                requestEvents.record(db, requestId, requestEvents.KINDS.LIGHTNING_REFUND_ADDRESS, `${normalized.address} (set by the operator)`);
                request.lnRefundAddress = normalized.address;
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

    /**
     * POST /api/admin/requests/:requestId/resolve-pending  { outcome: 'published'|'dropped', force? }
     *
     * The way out of `treasury_tx_unresolved`: a Lightning order whose signed treasury
     * transaction may or may not be on chain, which nothing automatic will touch. The
     * operator looks it up and says which; this checks the chain again and refuses an
     * answer the chain contradicts unless `force` says the operator knows better.
     *
     *   published  the order is recorded as delivered with that transaction.
     *   dropped    the record is cleared; the order is an ordinary failure again — the
     *              reconcile pass may republish it, or the customer is offered a refund.
     */
    router.post('/requests/:requestId/resolve-pending', protect, async (req, res) => {
        const { requestId } = req.params;
        const { outcome, force } = req.body || {};
        try {
            if (outcome !== 'published' && outcome !== 'dropped') {
                return res.status(400).json({ error: "outcome must be 'published' or 'dropped'." });
            }
            const row = await dbGet(db, 'SELECT * FROM requests WHERE id = ?', [requestId]);
            if (!row || !lightning.isLightningRow(row)) return res.status(404).json({ error: 'Lightning request not found.' });
            if (!row.pendingTxId || row.opReturnTxId || row.refundTxId) {
                return res.status(409).json({ error: 'This order has no unresolved treasury transaction.' });
            }
            if (row.status === 'processing_op_return' || row.status === 'refund_processing') {
                return res.status(409).json({ error: 'This order is being worked on right now. Try again in a minute.' });
            }

            // The same question every automatic retry asks (chainProviders.signedTxFate).
            // "published" needs it to exist; "dropped" needs it provably dead — an input
            // spent by a different, confirmed transaction. Anything else needs `force`.
            const fate = await chainProviders.signedTxFate(row.pendingTxHex, config);
            const contradicts = outcome === 'published' ? fate.state !== 'exists' : fate.state !== 'dead';
            if (contradicts && force !== true) {
                return res.status(409).json({
                    error: outcome === 'published'
                        ? `${row.pendingTxId} is not on chain as far as the explorers can tell (${fate.state}${fate.reason ? `: ${fate.reason}` : ''}). Send force:true if you have seen it yourself.`
                        : fate.state === 'exists'
                            ? `${row.pendingTxId} IS out there${fate.confirmed ? ' and confirmed' : ''}. It was published — record it as published instead.`
                            : `${row.pendingTxId} is not provably gone: none of its inputs is spent by a confirmed conflict yet. Send force:true if you are sure it can never confirm.`,
                    fate,
                    needsConfirmation: 'force',
                });
            }

            if (outcome === 'published') {
                const write = await dbRun(
                    db,
                    `UPDATE requests SET status = 'op_return_broadcasted', opReturnTxId = pendingTxId, opReturnTxHex = pendingTxHex,
                         changePath = ?, pendingTxId = NULL, pendingTxHex = NULL, failureReason = NULL
                     WHERE id = ? AND pendingTxId = ? AND opReturnTxId IS NULL AND refundTxId IS NULL
                       AND status NOT IN ('processing_op_return', 'refund_processing')`,
                    [treasury.TREASURY_PATH, requestId, row.pendingTxId]
                );
                if (write.changes !== 1) return res.status(409).json({ error: 'The order changed state. Refresh and retry.' });
                // The ledger learns what an unconfirmed one spent, as for any broadcast.
                if (fate.state === 'exists' && !fate.confirmed) {
                    treasury.noteBroadcast(row.pendingTxHex, treasury.getTreasuryAddress(rootNode, config.NETWORK), config.NETWORK);
                }
                requestEvents.record(db, requestId, requestEvents.KINDS.PUBLISHED, `operator confirmed ${row.pendingTxId} is on chain${contradicts ? ' (forced)' : ''}`);
                notifier.notifyDelivered({ requestId, message: row.message, payloadKind: row.payloadKind, opReturnTxId: row.pendingTxId }, config);
            } else {
                const write = await dbRun(
                    db,
                    `UPDATE requests SET pendingTxId = NULL, pendingTxHex = NULL, status = 'op_return_failed',
                         failureReason = ?
                     WHERE id = ? AND pendingTxId = ? AND opReturnTxId IS NULL AND refundTxId IS NULL
                       AND status NOT IN ('processing_op_return', 'refund_processing')`,
                    [`treasury_tx_dropped: the operator confirmed ${row.pendingTxId} is not on chain${contradicts ? ' (forced)' : ''}`, requestId, row.pendingTxId]
                );
                if (write.changes !== 1) return res.status(409).json({ error: 'The order changed state. Refresh and retry.' });
                requestEvents.record(db, requestId, requestEvents.KINDS.FULFIL_FAILED, `operator confirmed ${row.pendingTxId} is not on chain; record cleared${contradicts ? ' (forced)' : ''}`);
            }
            // This process may still hold the same bytes from an attempt whose answer was
            // lost. Once the operator has settled them, a retry must never re-send them.
            treasury.forgetAttempt(requestId);
            lightning.invalidateTreasuryCache();
            console.log(`[Admin] Resolved the pending treasury transaction of ${requestId} as ${outcome}${contradicts ? ' (forced)' : ''}.`);
            res.status(200).json({ success: true, outcome });
        } catch (error) {
            console.error(`Resolving ${requestId} failed:`, error.message);
            res.status(500).json({ error: 'Failed to resolve.' });
        }
    });

    /**
     * GET /api/admin/lightning — the phoenixd node and what the treasury owes.
     *
     * Read-only. `balanceSat` is spendable Lightning income; `feeCreditSat` is money
     * phoenixd holds towards future liquidity fees, which cannot be withdrawn. The
     * treasury figures are the ones intake decides with (lightning.canFund).
     */
    router.get('/lightning', protect, async (req, res) => {
        try {
            if (!config.LIGHTNING_CONFIGURED) return res.status(200).json({ enabled: false, configured: false });
            const [info, balance, spendable, reserved, offered] = await Promise.all([
                lightning.getInfo(config),
                lightning.getBalance(config),
                lightning.treasurySpendable(rootNode, config),
                lightning.treasuryReserved(db, config),
                lightning.isOfferedNow(db, rootNode, config),
            ]);
            const channels = info.ok ? (info.info.channels || []) : [];
            res.status(200).json({
                configured: true,
                // false when LIGHTNING_ENABLED=false: taking no new Lightning orders, while
                // still receiving payments on invoices already issued and paying refunds.
                enabled: !!config.LIGHTNING_ENABLED,
                // Whether the homepage is offering it right now (phoenixd up, treasury room).
                offered,
                reachable: info.ok && balance.ok,
                error: info.ok ? (balance.ok ? null : balance.reason) : info.reason,
                nodeId: info.ok ? info.info.nodeId : null,
                channels: channels.map((c) => ({
                    state: c.state, balanceSat: c.balanceSat, inboundLiquiditySat: c.inboundLiquiditySat, capacitySat: c.capacitySat,
                })),
                balanceSat: balance.ok ? balance.balanceSat : null,
                feeCreditSat: balance.ok ? balance.feeCreditSat : null,
                treasury: {
                    address: treasury.getTreasuryAddress(rootNode, config.NETWORK),
                    spendableSat: spendable.ok ? spendable.spendable : null,
                    reservedSat: reserved,
                    marginSat: config.LN_TREASURY_MARGIN_SATS,
                },
            });
        } catch (error) {
            console.error('Error reading Lightning status:', error.message);
            res.status(500).json({ error: 'Failed to read Lightning status' });
        }
    });

    /**
     * POST /api/admin/lightning/sweep  { amountSat, feerateSatByte }
     *
     * Moves Lightning income on-chain into the treasury, which is what pays for every
     * Lightning order. The destination is NOT a parameter: it is always the treasury
     * address derived here, so this endpoint cannot send money anywhere else even with the
     * admin password.
     *
     * A splice-out costs a mining fee each time, so it is a deliberate button rather than
     * a timer. Sweeping also frees inbound liquidity for the next payments.
     */
    router.post('/lightning/sweep', protect, async (req, res) => {
        try {
            if (!config.LIGHTNING_CONFIGURED) return res.status(404).json({ error: 'Lightning is not configured.' });
            const amountSat = Number((req.body || {}).amountSat);
            const feerateSatByte = Number((req.body || {}).feerateSatByte);
            if (!Number.isInteger(amountSat) || amountSat < 10_000) {
                return res.status(400).json({ error: 'amountSat must be a whole number of at least 10,000 sats.' });
            }
            if (!Number.isInteger(feerateSatByte) || feerateSatByte < 1 || feerateSatByte > 100) {
                return res.status(400).json({ error: 'feerateSatByte must be a whole number between 1 and 100.' });
            }
            const balance = await lightning.getBalance(config);
            if (!balance.ok) return res.status(502).json({ error: `Could not read the Lightning balance: ${balance.reason}` });
            if (amountSat > balance.balanceSat) {
                return res.status(400).json({ error: `Only ${balance.balanceSat} sats are available on Lightning.` });
            }
            const address = treasury.getTreasuryAddress(rootNode, config.NETWORK);
            const sent = await lightning.sendToAddress(config, { address, amountSat, feerateSatByte });
            if (!sent.ok) return res.status(502).json({ error: `phoenixd refused the sweep: ${sent.reason}` });
            lightning.invalidateTreasuryCache();
            console.log(`[Admin] Swept ${amountSat} sats from Lightning to the treasury ${address}: ${sent.txId}`);
            res.status(200).json({ success: true, txId: sent.txId, address, amountSat });
        } catch (error) {
            console.error('Lightning sweep failed:', error.message);
            res.status(500).json({ error: 'The sweep failed.' });
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