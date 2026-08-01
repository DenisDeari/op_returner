// backend/src/routes/admin.js
const express = require('express');
const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const { dbGet, dbAll, dbRun } = require('../db_utils');
const { deleteRequest, fulfillRequest } = require('../request_service');
const { attemptRefund, OPERATOR_REFUNDABLE_STATUSES } = require('../refund');
const { getTreasuryAddress } = require('../treasury');
const { computeAlerts } = require('../alerts');
const eventLog = require('../event_log');

function createAdminRouter(db, rootNode, config) {
    const router = express.Router();

    const ADMIN_PASSWORD = config.ADMIN_PASSWORD;

    const protect = (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader === `Bearer ${ADMIN_PASSWORD}`) {
            next();
        } else {
            res.status(401).json({ error: 'Unauthorized' });
        }
    };

    router.get('/wallet-balances', protect, async (req, res) => {
        try {
            // Treasury address (m/84'/0'/0'/2/0)
            const treasuryAddress = getTreasuryAddress(rootNode, config.NETWORK);

            // First user-facing receive address (m/84'/0'/0'/0/0)
            const coinType = config.NETWORK === bitcoin.networks.bitcoin ? 0 : 1;
            const userNode = rootNode.derivePath(`m/84'/${coinType}'/0'/0/0`);
            const userPubkey = Buffer.from(userNode.publicKey);
            const { address: userAddress } = bitcoin.payments.p2wpkh({ pubkey: userPubkey, network: config.NETWORK });

            // Fetch balances from mempool.space (no token needed)
            const [treasuryRes, userRes] = await Promise.all([
                axios.get(`https://mempool.space/api/address/${treasuryAddress}`),
                axios.get(`https://mempool.space/api/address/${userAddress}`)
            ]);

            const toBalance = (stats, mempoolStats) => ({
                confirmed: stats.funded_txo_sum - stats.spent_txo_sum,
                unconfirmed: mempoolStats.funded_txo_sum - mempoolStats.spent_txo_sum,
            });

            res.json({
                treasury: {
                    address: treasuryAddress,
                    path: "m/84'/0'/0'/2/0",
                    ...toBalance(treasuryRes.data.chain_stats, treasuryRes.data.mempool_stats),
                },
                userWallet: {
                    address: userAddress,
                    path: `m/84'/${coinType}'/0'/0/0`,
                    ...toBalance(userRes.data.chain_stats, userRes.data.mempool_stats),
                }
            });
        } catch (error) {
            console.error('Error fetching wallet balances:', error.message);
            res.status(500).json({ error: 'Failed to fetch wallet balances' });
        }
    });

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
            const rows = await dbAll(db, "SELECT * FROM requests ORDER BY createdAt DESC");
            res.status(200).json(rows);
        } catch (error) {
            res.status(500).json({ error: 'Failed to retrieve requests' });
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