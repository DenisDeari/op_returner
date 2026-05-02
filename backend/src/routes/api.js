// backend/src/routes/api.js
const express = require('express');
const axios = require('axios');
const { dbGet, dbRun } = require('../db_utils');
const { fulfillRequest, deleteRequest } = require('../request_service');

// Cache for self-heal checks to prevent API spam
const selfHealCache = {};
const CACHE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const CACHE_ENTRY_MAX_AGE_MS = 5 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const key of Object.keys(selfHealCache)) {
        if (now - selfHealCache[key] > CACHE_ENTRY_MAX_AGE_MS) {
            delete selfHealCache[key];
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[SelfHeal] Cleaned ${cleaned} stale cache entries`);
    }
}, CACHE_CLEANUP_INTERVAL_MS);

function createApiRouter(db, rootNode, config, requestQueue) {
    const router = express.Router();

    // --- Optional API Key Middleware ---
    // If X-API-Key header is provided, validate it. Otherwise allow through (public access).
    const optionalApiKey = (req, res, next) => {
        const apiKey = req.headers['x-api-key'];
        if (apiKey) {
            if (!config.API_KEY || apiKey !== config.API_KEY) {
                return res.status(401).json({ error: 'Invalid API key' });
            }
        }
        next();
    };

    // --- Public Endpoints ---
    router.get('/health', (req, res) => {
        res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
    });

    router.get('/config/limits', (req, res) => {
        db.get("SELECT value FROM system_settings WHERE key = 'max_payload_size'", (err, row) => {
            if (err) {
                console.error("Error fetching max_payload_size:", err);
                return res.status(500).json({ error: "Internal server error" });
            }
            const limit = row ? parseInt(row.value, 10) : 1000;
            res.json({ maxPayloadSize: limit });
        });
    });

    // --- Authenticated Endpoints ---
    router.post('/message-request', optionalApiKey, async (req, res) => {
        const { message, targetAddress, feeRate, amountToSend } = req.body;

        try {
            const limitRow = await new Promise((resolve) => {
                db.get("SELECT value FROM system_settings WHERE key = 'max_payload_size'", (err, row) => {
                    resolve(row);
                });
            });
            const maxPayloadSize = limitRow ? parseInt(limitRow.value, 10) : 1000;

            if (!message || Buffer.byteLength(message, 'utf8') > maxPayloadSize) {
                return res.status(400).json({ error: `Message is required and must be under ${maxPayloadSize} bytes.` });
            }

            const result = await requestQueue.add(message, targetAddress, feeRate, amountToSend, db, rootNode, config);

            const webhookManager = require('../webhook_manager');
            const hookId = await webhookManager.registerWebhook(result.address, config);
            if (hookId) {
                db.run('UPDATE requests SET blockcypherHookId = ? WHERE id = ?', [hookId, result.newRequestId]);
                console.log(`Successfully updated hook ID ${hookId} for request ${result.newRequestId}`);
            }

            res.status(201).json({
                requestId: result.newRequestId,
                address: result.address,
                requiredAmountSatoshis: result.requiredAmountSatoshis,
                message: "Send the specified amount to the address to embed your message."
            });
        } catch (error) {
            console.error(`Error in /api/message-request:`, error);
            res.status(500).json({ error: "Failed to process message request." });
        }
    });

    router.get('/request-status/:requestId', optionalApiKey, async (req, res) => {
        const { requestId } = req.params;
        try {
            const row = await dbGet(db, "SELECT * FROM requests WHERE id = ?", [requestId]);

            if (!row) {
                return res.status(404).json({ error: 'Request not found' });
            }

            // Self-Healing: Check blockchain if pending and older than 15s
            const ageInSeconds = (new Date() - new Date(row.createdAt)) / 1000;
            const now = Date.now();
            const lastCheck = selfHealCache[requestId] || 0;
            const shouldCheck = (now - lastCheck) > 30000;

            if ((row.status === 'pending_payment' || row.status === 'payment_detected') && ageInSeconds > 15 && shouldCheck) {
                selfHealCache[requestId] = now;
                try {
                    const apiUrl = `${config.BLOCKCYPHER_API_BASE}/addrs/${row.address}/full?token=${config.BLOCKCYPHER_TOKEN}&limit=5`;
                    const response = await axios.get(apiUrl);
                    const data = response.data;

                    let foundTx = null;
                    if (data.txs) {
                        for (const tx of data.txs) {
                            for (const output of tx.outputs) {
                                if (output.addresses && output.addresses.includes(row.address)) {
                                    if (output.value >= row.requiredAmountSatoshis) {
                                        foundTx = tx;
                                        break;
                                    }
                                }
                            }
                            if (foundTx) break;
                        }
                    }

                    if (foundTx) {
                        const confirmations = foundTx.confirmations || 0;
                        const txHash = foundTx.hash;

                        if (confirmations >= 1 && row.status !== 'payment_confirmed') {
                            console.log(`[Self-Heal] Confirmed payment found for ${requestId}: ${txHash}`);
                            await dbRun(db, "UPDATE requests SET status = 'payment_confirmed', paymentTxId = ? WHERE id = ?", [txHash, requestId]);

                            const updatedRow = { ...row, status: 'payment_confirmed', paymentTxId: txHash };
                            fulfillRequest(updatedRow, db, rootNode, config).then(result => {
                                if (result.success) {
                                    console.log(`[Self-Heal] OP_RETURN successful for ${requestId}: ${result.opReturnTxId}`);
                                } else {
                                    console.log(`[Self-Heal] OP_RETURN failed for ${requestId}: ${result.error}`);
                                }
                            });
                            row.status = 'processing_op_return';
                        } else if (confirmations === 0 && row.status === 'pending_payment') {
                            console.log(`[Self-Heal] Unconfirmed payment detected for ${requestId}: ${txHash}`);
                            await dbRun(db, "UPDATE requests SET status = 'payment_detected', paymentTxId = ? WHERE id = ?", [txHash, requestId]);
                            row.status = 'payment_detected';
                        }
                    }
                } catch (apiError) {
                    if (apiError.response && apiError.response.status === 429) {
                        console.warn(`[Self-Heal] Rate limit hit for ${requestId}. Backing off.`);
                        selfHealCache[requestId] = now + 60000;
                    }
                }
            }

            const responseBody = { ...row };
            if (row.status === 'op_return_failed' && config.SUPPORT_EMAIL) {
                responseBody.supportEmail = config.SUPPORT_EMAIL;
            }
            res.status(200).json(responseBody);
        } catch (error) {
            console.error(`Error in /api/request-status/${requestId}:`, error);
            res.status(500).json({ error: 'Failed to retrieve request status' });
        }
    });

    router.delete('/request/:requestId', optionalApiKey, async (req, res) => {
        const { requestId } = req.params;
        console.log(`DELETE /api/request/${requestId}`);
        try {
            const result = await deleteRequest(requestId, db, config);

            if (!result.success) {
                return res.status(404).json({ error: result.error || 'Request not found' });
            }

            res.status(200).json({ message: 'Request deleted successfully' });
        } catch (error) {
            console.error(`Error deleting request ${requestId}:`, error);
            res.status(500).json({ error: 'Failed to delete request' });
        }
    });

    return router;
}

module.exports = createApiRouter;
