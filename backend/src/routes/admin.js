// backend/src/routes/admin.js
const express = require('express');
const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const opReturnCreator = require('../op_return_creator');
const { dbGet, dbAll, dbRun } = require('../db_utils');
const { deleteRequest } = require('../request_service');
const { getTreasuryAddress } = require('../treasury');

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

            const result = await opReturnCreator.createOpReturnTransaction(request, rootNode, config.NETWORK, {
                BLOCKCYPHER_API_BASE: config.BLOCKCYPHER_API_BASE,
                BLOCKCYPHER_TOKEN: config.BLOCKCYPHER_TOKEN
            });

            if (result && result.opReturnTxId) {
                await dbRun(db, "UPDATE requests SET status = 'op_return_broadcasted', opReturnTxId = ? WHERE id = ?", [result.opReturnTxId, requestId]);
                res.status(200).json({ success: true, txId: result.opReturnTxId });
            } else {
                await dbRun(db, "UPDATE requests SET status = 'op_return_failed' WHERE id = ?", [requestId]);
                res.status(500).json({ error: 'Failed to create OP_RETURN transaction.' });
            }
        } catch (error) {
            console.error(`Manual fulfillment failed for ${requestId}:`, error);
            res.status(500).json({ error: 'An error occurred during manual fulfillment.' });
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