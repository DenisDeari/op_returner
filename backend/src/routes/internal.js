// backend/src/routes/internal.js
// Internal self-funded API endpoints — requires API key, no user payment needed.

const express = require('express');
const { getTreasuryAddress, fetchTreasuryUtxos, createSelfFundedOpReturn } = require('../treasury');

function createInternalRouter(db, rootNode, config) {
    const router = express.Router();

    // Strict API key auth — always required for internal endpoints
    const requireApiKey = (req, res, next) => {
        const apiKey = req.headers['x-api-key'];
        if (!config.API_KEY || apiKey !== config.API_KEY) {
            return res.status(401).json({ error: 'Valid X-API-Key header required' });
        }
        next();
    };

    /**
     * GET /api/internal/treasury
     * Returns treasury address and current confirmed balance.
     */
    router.get('/treasury', requireApiKey, async (req, res) => {
        try {
            const address = getTreasuryAddress(rootNode, config.NETWORK);
            const utxos = await fetchTreasuryUtxos(address, config);
            const balance = utxos.reduce((sum, u) => sum + u.value, 0);

            res.json({
                address,
                confirmedBalanceSats: balance,
                utxoCount: utxos.length,
            });
        } catch (error) {
            console.error('[Internal] /treasury error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/internal/embed
     * Immediately creates and broadcasts an OP_RETURN tx funded from the treasury.
     * No user payment required.
     *
     * Body:
     *   message       {string}  - required, UTF-8 text to embed
     *   targetAddress {string}  - optional, Bitcoin address to include as recipient
     *   amountToSend  {number}  - optional, sats to send to targetAddress
     *   feeRate       {number}  - optional, sats/vByte (default: 2)
     */
    router.post('/embed', requireApiKey, async (req, res) => {
        const { message, targetAddress, feeRate, amountToSend } = req.body;

        if (!message || Buffer.byteLength(message, 'utf8') === 0) {
            return res.status(400).json({ error: 'message is required' });
        }

        // Respect the same max payload setting as the public API
        const limitRow = await new Promise((resolve) => {
            db.get("SELECT value FROM system_settings WHERE key = 'max_payload_size'", (err, row) => resolve(row));
        });
        const maxPayloadSize = limitRow ? parseInt(limitRow.value, 10) : 1000;

        if (Buffer.byteLength(message, 'utf8') > maxPayloadSize) {
            return res.status(400).json({ error: `Message exceeds max payload size of ${maxPayloadSize} bytes` });
        }

        try {
            const result = await createSelfFundedOpReturn(
                message,
                targetAddress || null,
                feeRate ? parseInt(feeRate) : null,
                amountToSend ? parseInt(amountToSend) : null,
                rootNode,
                config
            );

            res.status(201).json({
                txId: result.txId,
                message,
                treasuryAddress: result.treasuryAddress,
                feePaid: result.fee,
                mempoolUrl: `https://mempool.space/tx/${result.txId}`,
            });
        } catch (error) {
            console.error('[Internal] /embed error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}

module.exports = createInternalRouter;
