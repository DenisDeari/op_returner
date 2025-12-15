// backend/src/routes/api.js
const express = require('express');
const axios = require('axios');
const opReturnCreator = require('../op_return_creator');
const webhookManager = require('../webhook_manager');

// Cache for self-heal checks to prevent API spam
const selfHealCache = {};

// This function creates a router and injects dependencies (db, wallet, etc.)
function createApiRouter(db, rootNode, config, requestQueue) {
    const router = express.Router();

    // --- API Endpoints ---
    router.get('/health', (req, res) => {
        res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
    });

    router.get('/request-status/:requestId', async (req, res) => {
        const { requestId } = req.params;
        // console.log(`GET /api/request-status for ID: ${requestId}`);
        try {
            const row = await new Promise((resolve, reject) => {
                db.get("SELECT * FROM requests WHERE id = ?", [requestId], (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                });
            });

            if (!row) {
                return res.status(404).json({ error: 'Request not found' });
            }

            // Self-Healing: Check blockchain if pending and older than 15s
            const ageInSeconds = (new Date() - new Date(row.createdAt)) / 1000;
            const now = Date.now();
            const lastCheck = selfHealCache[requestId] || 0;
            const shouldCheck = (now - lastCheck) > 30000; // Check max every 30 seconds

            if ((row.status === 'pending_payment' || row.status === 'payment_detected') && ageInSeconds > 15 && shouldCheck) {
                selfHealCache[requestId] = now; // Update cache timestamp
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
                            
                            await new Promise((resolve, reject) => {
                                db.run("UPDATE requests SET status = 'payment_confirmed', paymentTxId = ? WHERE id = ?", [txHash, requestId], (err) => err ? reject(err) : resolve());
                            });

                            const updatedRow = { ...row, status: 'payment_confirmed', paymentTxId: txHash };
                            
                            const lockAcquired = await new Promise((resolve, reject) => {
                                db.run("UPDATE requests SET status = 'processing_op_return' WHERE id = ? AND status = 'payment_confirmed'", [requestId], function(err) {
                                    if (err) return reject(err);
                                    resolve(this.changes > 0);
                                });
                            });

                            if (lockAcquired) {
                                console.log(`[Self-Heal] Triggering OP_RETURN for ${requestId}`);
                                opReturnCreator.createOpReturnTransaction(updatedRow, rootNode, config.NETWORK, { BLOCKCYPHER_API_BASE: config.BLOCKCYPHER_API_BASE, BLOCKCYPHER_TOKEN: config.BLOCKCYPHER_TOKEN })
                                    .then(result => {
                                        const finalStatus = result && result.opReturnTxId ? 'op_return_broadcasted' : 'op_return_failed';
                                        db.run("UPDATE requests SET status = ?, opReturnTxId = ?, opReturnTxHex = ? WHERE id = ?", 
                                            [finalStatus, result?.opReturnTxId, result?.signedTxHex, requestId]);
                                        
                                        // Cleanup webhook after completion
                                        if (row.blockcypherHookId) {
                                            webhookManager.deleteWebhook(row.blockcypherHookId, config);
                                        }
                                    })
                                    .catch(err => console.error(`[Self-Heal] OP_RETURN error:`, err));
                                
                                row.status = 'processing_op_return'; 
                            }
                        } else if (confirmations === 0 && row.status === 'pending_payment') {
                            console.log(`[Self-Heal] Unconfirmed payment detected for ${requestId}: ${txHash}`);
                            await new Promise((resolve, reject) => {
                                db.run("UPDATE requests SET status = 'payment_detected', paymentTxId = ? WHERE id = ?", [txHash, requestId], (err) => err ? reject(err) : resolve());
                            });
                            row.status = 'payment_detected';
                        }
                    }
                } catch (apiError) {
                    // Silently fail on API errors
                    if (apiError.response && apiError.response.status === 429) {
                        console.warn(`[Self-Heal] Rate limit hit for ${requestId}. Backing off.`);
                        selfHealCache[requestId] = now + 60000; // Add extra minute backoff
                    }
                }
            }

            res.status(200).json(row);
        } catch (error) { // <-- THIS LINE IS NOW CORRECTED
            console.error(`Error in /api/request-status/${requestId}:`, error);
            res.status(500).json({ error: 'Failed to retrieve request status' });
        }
    });

    router.delete('/request/:requestId', async (req, res) => {
        const { requestId } = req.params;
        console.log(`DELETE /api/request/${requestId}`);
        try {
            // Get hook ID before deleting
            const row = await new Promise((resolve, reject) => {
                db.get("SELECT blockcypherHookId FROM requests WHERE id = ?", [requestId], (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                });
            });

            if (row && row.blockcypherHookId) {
                webhookManager.deleteWebhook(row.blockcypherHookId, config);
            }

            await new Promise((resolve, reject) => {
                db.run("DELETE FROM requests WHERE id = ?", [requestId], function(err) {
                    if (err) return reject(err);
                    resolve();
                });
            });
            res.status(200).json({ message: 'Request deleted successfully' });
        } catch (error) {
            console.error(`Error deleting request ${requestId}:`, error);
            res.status(500).json({ error: 'Failed to delete request' });
        }
    });

    router.post('/message-request', async (req, res) => {
        const { message, targetAddress, isPublic, feeRate, amountToSend, refundAddress } = req.body;
        // Increased limit to 8000 bytes to match frontend
        if (!message || Buffer.byteLength(message, 'utf8') > 8000) {
            return res.status(400).json({ error: "Message is required and must be under 8000 bytes." });
        }

        try {
            const result = await requestQueue.add(message, targetAddress, isPublic, feeRate, amountToSend, refundAddress, db, rootNode, config);
            
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

    router.get('/recent-messages', async (req, res) => {
        try {
            const rows = await new Promise((resolve, reject) => {
                const sql = `
                    SELECT message, createdAt, opReturnTxId, paymentTxId 
                    FROM requests 
                    WHERE (status = 'payment_confirmed' OR status = 'op_return_broadcasted') 
                    AND isPublic = 1 
                    ORDER BY createdAt DESC 
                    LIMIT 10
                `;
                db.all(sql, [], (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                });
            });
            res.status(200).json(rows);
        } catch (error) {
            console.error("Error fetching recent messages:", error);
            res.status(500).json({ error: "Failed to fetch recent messages." });
        }
    });

    router.post('/request/:requestId/refund', async (req, res) => {
        const { requestId } = req.params;
        const { refundAddress } = req.body;
        
        if (!refundAddress) return res.status(400).json({ error: 'Refund address is required' });

        try {
            await new Promise((resolve, reject) => {
                db.run("UPDATE requests SET refundAddress = ? WHERE id = ?", [refundAddress, requestId], function(err) {
                    if (err) return reject(err);
                    resolve();
                });
            });
            res.status(200).json({ success: true });
        } catch (error) {
            console.error("Error updating refund address:", error);
            res.status(500).json({ error: "Failed to update refund address" });
        }
    });

    return router;
}

module.exports = createApiRouter;
