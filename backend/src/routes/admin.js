// backend/src/routes/admin.js
const express = require('express');
const axios = require('axios'); // Import axios
const opReturnCreator = require('../op_return_creator');
const { dbGet, dbAll, dbRun } = require('../db_utils');
const { deleteRequest } = require('../request_service');

function createAdminRouter(db, rootNode, config) {
    const router = express.Router();

    // Use the password from your .env file via the config object
    const ADMIN_PASSWORD = config.ADMIN_PASSWORD;

    // ✅ CORRECTED Middleware for simple password protection
    const protect = (req, res, next) => {
        const authHeader = req.headers.authorization; // Look for the password in the header

        // Check if the header exists and matches "Bearer your-password"
        if (authHeader && authHeader === `Bearer ${ADMIN_PASSWORD}`) {
            next(); // Password is correct, proceed to the route
        } else {
            res.status(401).json({ error: 'Unauthorized' }); // Password is wrong or missing
        }
    };

    router.get('/requests', protect, async (req, res) => { // Apply the corrected middleware
        try {
            const rows = await dbAll(db, "SELECT * FROM requests ORDER BY createdAt DESC");
            res.status(200).json(rows);
        } catch (error) {
            res.status(500).json({ error: 'Failed to retrieve requests' });
        }
    });

    // Update system limits
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

    // This route does not need to change
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