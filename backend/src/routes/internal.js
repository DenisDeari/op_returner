// backend/src/routes/internal.js
// Internal self-funded API endpoints — requires API key, no user payment needed.

const express = require('express');
const { getTreasuryAddress, fetchTreasuryUtxos, createSelfFundedOpReturn } = require('../treasury');
const { validateRequestParams } = require('./api');

// Which HTTP status a treasury failure deserves. A permanent failure is the caller's
// problem — the request cannot succeed as written — while a transient one is ours, and
// answering 400 to a provider outage would tell an automated caller to stop retrying
// something that is going to start working again on its own.
function statusForFailure(result) {
    if (result.reason === 'invalid_message' || result.reason === 'invalid_target_address') return 400;
    if (result.reason === 'exceeds_max_spend') return 422;
    if (result.reason === 'insufficient_treasury_funds') return 503;
    return result.permanent ? 422 : 503;
}

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
     * Returns treasury address and current balance.
     */
    router.get('/treasury', requireApiKey, async (req, res) => {
        try {
            const address = getTreasuryAddress(rootNode, config.NETWORK);
            const result = await fetchTreasuryUtxos(address, config);

            // A balance that could not be read is never reported as 0 — the same rule the
            // wallet view follows. The address is still worth returning: it is what a
            // top-up is sent to, and it is derived locally rather than fetched.
            if (!result.ok) {
                return res.status(503).json({
                    address,
                    error: `Could not read the treasury's unspent outputs: ${result.reason}`,
                    balanceKnown: false,
                });
            }

            const confirmed = result.utxos.filter((u) => u.confirmed);
            res.json({
                address,
                balanceKnown: true,
                confirmedBalanceSats: confirmed.reduce((sum, u) => sum + u.value, 0),
                unconfirmedBalanceSats: result.utxos.filter((u) => !u.confirmed).reduce((sum, u) => sum + u.value, 0),
                utxoCount: result.utxos.length,
                confirmedUtxoCount: confirmed.length,
                provider: result.provider,
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

        if (typeof message !== 'string' || Buffer.byteLength(message, 'utf8') === 0) {
            return res.status(400).json({ error: 'message is required' });
        }

        // Respect the same max payload setting as the public API
        const limitRow = await new Promise((resolve) => {
            db.get("SELECT value FROM system_settings WHERE key = 'max_payload_size'", (err, row) => resolve(row));
        });
        // Guarded rather than trusted. `Buffer.byteLength(msg) > NaN` is always false, so
        // an unparseable settings row did not fall back to the default — it removed the
        // limit entirely, on the one endpoint that spends the operator's own money.
        const parsedLimit = limitRow ? parseInt(limitRow.value, 10) : NaN;
        const maxPayloadSize = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 1000;

        if (Buffer.byteLength(message, 'utf8') > maxPayloadSize) {
            return res.status(400).json({ error: `Message exceeds max payload size of ${maxPayloadSize} bytes` });
        }

        // The same economic validation the public intake applies, and for the same reason
        // one step removed: this path spends the operator's money instead of a customer's,
        // so a bad parameter costs the operator a broadcast rather than costing a customer
        // a refund. It used to parseInt whatever arrived and hand it straight to the
        // builder, where a sub-dust payout was silently RAISED to the dust limit — quietly
        // spending more than the caller asked for — and an out-of-range fee rate was not
        // checked at all. Rejecting beats clamping when there is somebody to tell.
        const parsedFeeRate = feeRate === undefined || feeRate === null || feeRate === ''
            ? null : Number(feeRate);
        const parsedAmount = amountToSend === undefined || amountToSend === null || amountToSend === ''
            ? null : Number(amountToSend);
        if (parsedFeeRate !== null && !Number.isInteger(parsedFeeRate)) {
            return res.status(400).json({ error: 'feeRate must be an integer number of sats/vByte.' });
        }
        if (parsedAmount !== null && !Number.isInteger(parsedAmount)) {
            return res.status(400).json({ error: 'amountToSend must be an integer number of satoshis.' });
        }
        const paramError = validateRequestParams({
            targetAddress: targetAddress || null,
            feeRate: parsedFeeRate === null ? undefined : parsedFeeRate,
            amountToSend: parsedAmount === null ? undefined : parsedAmount,
        }, config);
        if (paramError) {
            console.log(`[Internal] Rejected /embed at intake: ${paramError}`);
            return res.status(400).json({ error: paramError });
        }

        try {
            const result = await createSelfFundedOpReturn({
                message,
                // Text only on this endpoint. Named rather than omitted, because
                // payload.js reads a missing kind as text and an image row would
                // otherwise reach the chain as base64 ASCII.
                payloadKind: null,
                targetAddress: targetAddress || null,
                feeRate: parsedFeeRate,
                amountToSend: parsedAmount,
            }, rootNode, config);

            // A classified result rather than a thrown Error, so "top the treasury up" and
            // "this can never be published" no longer arrive as the same 500.
            if (!result.ok) {
                console.error(`[Internal] /embed failed (${result.reason}): ${result.detail}`);
                return res.status(statusForFailure(result)).json({
                    error: result.detail || result.reason,
                    reason: result.reason,
                    permanent: result.permanent,
                });
            }

            res.status(201).json({
                txId: result.txId,
                message,
                treasuryAddress: result.treasuryAddress,
                feePaid: result.fee,
                vBytes: result.vBytes,
                inputCount: result.inputCount,
                changeSats: result.changeValue,
                alreadyBroadcast: result.alreadyBroadcast,
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
