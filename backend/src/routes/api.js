// backend/src/routes/api.js
const express = require('express');
const axios = require('axios');

// This function creates a router and injects dependencies (db, wallet, etc.)
function createApiRouter(db, rootNode, config, requestQueue) {
    const router = express.Router();

    // --- Helper for Webhook Registration ---
    async function registerWebhook(btcAddress) {
        if (!config.BLOCKCYPHER_TOKEN) {
            console.warn("BLOCKCYPHER_TOKEN not found. Skipping webhook registration.");
            return null;
        }
        const webhookUrl = `${config.WEBHOOK_RECEIVER_BASE_URL}/api/webhook/payment-notification`;
        const apiUrl = `${config.BLOCKCYPHER_API_BASE}/hooks?token=${config.BLOCKCYPHER_TOKEN}`;
        
        const events = ["unconfirmed-tx", "confirmed-tx"];
        const hookIds = [];

        console.log(`Registering webhooks for ${btcAddress}...`);

        for (const eventType of events) {
            const payload = { event: eventType, address: btcAddress, url: webhookUrl };
            try {
                const response = await axios.post(apiUrl, payload);
                console.log(`Successfully registered ${eventType} webhook. ID: ${response.data.id}`);
                hookIds.push(response.data.id);
            } catch (error) {
                console.error(`Error registering ${eventType} webhook:`, error.message);
                if (error.response) {
                    console.error('API Error Status:', error.response.status, 'Data:', error.response.data);
                }
            }
        }
        return hookIds.length > 0 ? hookIds.join(',') : null;
    }

    // --- API Endpoints ---
    router.get('/health', (req, res) => {
        res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
    });

    router.get('/request-status/:requestId', async (req, res) => {
        const { requestId } = req.params;
        console.log(`GET /api/request-status for ID: ${requestId}`);
        try {
            const row = await new Promise((resolve, reject) => {
                db.get("SELECT * FROM requests WHERE id = ?", [requestId], (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                });
            });
            if (row) {
                res.status(200).json(row);
            } else {
                res.status(404).json({ error: 'Request not found' });
            }
        } catch (error) { // <-- THIS LINE IS NOW CORRECTED
            console.error(`Error in /api/request-status/${requestId}:`, error);
            res.status(500).json({ error: 'Failed to retrieve request status' });
        }
    });

    router.delete('/request/:requestId', async (req, res) => {
        const { requestId } = req.params;
        console.log(`DELETE /api/request/${requestId}`);
        try {
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
        if (!message || Buffer.byteLength(message, 'utf8') > 80) {
            return res.status(400).json({ error: "Message is required and must be under 80 bytes." });
        }

        try {
            const result = await requestQueue.add(message, targetAddress, isPublic, feeRate, amountToSend, refundAddress, db, rootNode, config);
            
            const hookId = await registerWebhook(result.address);
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

    return router;
}

module.exports = createApiRouter;
