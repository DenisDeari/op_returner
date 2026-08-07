// backend/src/routes/api.js
const express = require('express');
const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const { dbGet, dbRun } = require('../db_utils');
const { fulfillRequest, deleteRequest } = require('../request_service');
const notifier = require('../notifier');
const txSizing = require('../tx_sizing');

/**
 * Validates the economic parameters of a request BEFORE a payment address is issued.
 *
 * This ordering is the whole point: these values used to be accepted unchecked and
 * only validated when the transaction was broadcast — by which time the customer had
 * already paid. A sub-dust `amountToSend` produced a non-standard transaction that
 * relays rejected, leaving the money collected and the message unpublished.
 *
 * @returns {string|null} an error message, or null if the parameters are acceptable
 */
function validateRequestParams({ targetAddress, feeRate, amountToSend }, config) {
    // --- feeRate ---
    if (feeRate !== undefined && feeRate !== null) {
        if (!Number.isInteger(feeRate)) {
            return 'feeRate must be an integer number of sats/vByte.';
        }
        if (feeRate < config.MIN_FEE_RATE || feeRate > config.MAX_FEE_RATE) {
            return `feeRate must be between ${config.MIN_FEE_RATE} and ${config.MAX_FEE_RATE} sats/vByte.`;
        }
    }

    // --- targetAddress ---
    // The script is kept, not just checked: the dust limit below depends on which kind
    // of output this address produces.
    let targetScript = null;
    if (targetAddress !== undefined && targetAddress !== null && targetAddress !== '') {
        if (typeof targetAddress !== 'string') {
            return 'targetAddress must be a string.';
        }
        try {
            targetScript = bitcoin.address.toOutputScript(targetAddress, config.NETWORK);
        } catch {
            return 'targetAddress is not a valid Bitcoin address for this network.';
        }
    }

    // --- amountToSend ---
    if (amountToSend !== undefined && amountToSend !== null && amountToSend !== 0) {
        if (!Number.isInteger(amountToSend) || amountToSend < 0) {
            return 'amountToSend must be a non-negative integer number of satoshis.';
        }
        if (amountToSend > 0 && !targetScript) {
            return 'amountToSend requires a targetAddress to send it to.';
        }
        // The dust limit is a property of the recipient's script type, not one constant.
        // 546 clears a P2PKH output but not a P2WSH one, and on 2026-08-06 four orders
        // paying 548 sats to a P2WSH address were quoted, paid, and only then rejected by
        // the network as dust. Measure against the address the customer actually gave.
        const minAmountToSend = txSizing.dustLimitForScript(targetScript, config);
        if (amountToSend > 0 && amountToSend < minAmountToSend) {
            return `amountToSend must be 0 or at least ${minAmountToSend} sats for this address type. Below that the output is treated as dust and rejected by the network.`;
        }
        if (amountToSend > config.MAX_AMOUNT_TO_SEND_SATS) {
            return `amountToSend exceeds the maximum of ${config.MAX_AMOUNT_TO_SEND_SATS} sats.`;
        }
    }

    return null;
}

/**
 * The real client address.
 *
 * This app sits behind Cloudflare and a tunnel, so `req.ip` is the proxy's address and is
 * identical for every visitor — keying a rate limit on it alone would make one global
 * bucket that any single user could exhaust for everyone.
 */
function clientIp(req) {
    return req.headers['cf-connecting-ip']
        || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.ip
        || req.socket?.remoteAddress
        || 'unknown';
}

/**
 * Sliding-window counter shared by the intake and feedback limiters.
 *
 * `store` maps ip -> [timestamps]. Timestamps older than the longest window are dropped
 * on read, so the map self-prunes on the addresses that are actually active; the periodic
 * sweep handles the ones that go quiet.
 */
function withinLimit(store, ip, windows) {
    const now = Date.now();
    const longest = Math.max(...windows.map((w) => w.ms));
    const stamps = (store.get(ip) || []).filter((t) => t > now - longest);
    for (const w of windows) {
        if (stamps.filter((t) => t > now - w.ms).length >= w.max) {
            store.set(ip, stamps);
            return { ok: false, window: w };
        }
    }
    store.set(ip, stamps);
    return { ok: true, record: () => store.set(ip, [...stamps, now]) };
}

function sweepRateLimit(store, maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [ip, stamps] of store) {
        const recent = stamps.filter((t) => t > cutoff);
        if (recent.length === 0) store.delete(ip);
        else store.set(ip, recent);
    }
}

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

    // Intake throttling. Creating a request permanently burns a wallet index and
    // registers two BlockCypher webhooks, and rows are archived rather than deleted, so
    // nothing else bounds this table. See the note in config.js for how the limits were
    // sized. Counted only once a request is about to be created — a caller who merely
    // fails validation has cost us nothing and should keep getting real error messages.
    const intakeRateLimit = new Map(); // ip -> [timestamps]
    const INTAKE_WINDOWS = [
        { ms: 60 * 60 * 1000, max: config.INTAKE_MAX_PER_HOUR, label: 'hour' },
        { ms: 24 * 60 * 60 * 1000, max: config.INTAKE_MAX_PER_DAY, label: 'day' },
    ];
    setInterval(() => sweepRateLimit(intakeRateLimit, 24 * 60 * 60 * 1000), 60 * 60 * 1000).unref?.();

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

            // Buffer.byteLength throws a TypeError on a non-string, which would surface
            // as a 500 from the catch below instead of a 400 for malformed input.
            if (typeof message !== 'string' || !message || Buffer.byteLength(message, 'utf8') > maxPayloadSize) {
                return res.status(400).json({ error: `Message is required, must be a string, and must be under ${maxPayloadSize} bytes.` });
            }

            // Reject economically impossible requests before quoting a payment address,
            // so we never take money for a transaction we cannot broadcast.
            const paramError = validateRequestParams({ targetAddress, feeRate, amountToSend }, config);
            if (paramError) {
                console.log(`[API] Rejected message-request at intake: ${paramError}`);
                return res.status(400).json({ error: paramError });
            }

            // Throttled here, after validation and immediately before anything is
            // consumed. A caller presenting a valid API key is the operator or the
            // internal service and is exempt.
            const authenticated = !!(req.headers['x-api-key'] && config.API_KEY
                && req.headers['x-api-key'] === config.API_KEY);
            let recordIntake = null;
            if (!authenticated) {
                const ip = clientIp(req);
                const gate = withinLimit(intakeRateLimit, ip, INTAKE_WINDOWS);
                if (!gate.ok) {
                    console.warn(`[API] Intake rate limit hit for ${ip}: over ${gate.window.max} per ${gate.window.label}.`);
                    return res.status(429).json({
                        error: `Too many requests created. The limit is ${gate.window.max} per ${gate.window.label}. Please try again later.`,
                    });
                }
                recordIntake = gate.record;
            }

            const result = await requestQueue.add(message, targetAddress, feeRate, amountToSend, db, rootNode, config);
            if (recordIntake) recordIntake();

            const webhookManager = require('../webhook_manager');
            const hookId = await webhookManager.registerWebhook(result.address, config);
            if (hookId) {
                db.run('UPDATE requests SET blockcypherHookId = ? WHERE id = ?', [hookId, result.newRequestId]);
                console.log(`Successfully updated hook ID ${hookId} for request ${result.newRequestId}`);
            }

            // Fire-and-forget: a notification problem must never affect the order.
            notifier.notifyNewOrder({
                requestId: result.newRequestId,
                message,
                requiredAmountSatoshis: result.requiredAmountSatoshis,
                targetAddress,
            }, config);

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
                    let foundValue = null;
                    if (data.txs) {
                        for (const tx of data.txs) {
                            for (const output of tx.outputs) {
                                if (output.addresses && output.addresses.includes(row.address)) {
                                    if (output.value >= row.requiredAmountSatoshis) {
                                        foundTx = tx;
                                        foundValue = output.value;
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
                        // Capture the payer so this request stays refundable if it fails.
                        const payerAddress = foundTx.inputs?.find(i => i.addresses?.length)?.addresses?.[0] || null;

                        if (confirmations >= 1 && row.status !== 'payment_confirmed') {
                            console.log(`[Self-Heal] Confirmed payment found for ${requestId}: ${txHash}`);
                            await dbRun(
                                db,
                                `UPDATE requests
                                 SET status = 'payment_confirmed', paymentTxId = ?, paymentReceivedSatoshis = ?,
                                     paymentConfirmationCount = ?, paymentConfirmedAt = ?,
                                     refundAddress = COALESCE(refundAddress, ?)
                                 WHERE id = ?`,
                                [txHash, foundValue, confirmations, new Date().toISOString(), payerAddress, requestId]
                            );

                            const updatedRow = {
                                ...row,
                                status: 'payment_confirmed',
                                paymentTxId: txHash,
                                paymentReceivedSatoshis: foundValue,
                                refundAddress: row.refundAddress || payerAddress,
                            };
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

    // --- Customer feedback on a failed request ---------------------------
    // When a request does not succeed the customer has no way to reach the operator
    // beyond a support email. This lets them leave a note directly against the request,
    // which the admin panel surfaces.
    //
    // Public endpoint, so it is deliberately narrow: only for requests that genuinely
    // failed, size-capped, and rate limited per IP.
    const FEEDBACK_ALLOWED_STATUSES = ['op_return_failed', 'refund_failed', 'refund_processing', 'refunded'];
    const feedbackRateLimit = new Map(); // ip -> [timestamps]
    const FEEDBACK_WINDOW_MS = 60 * 60 * 1000;
    const FEEDBACK_MAX_PER_WINDOW = 10;

    const FEEDBACK_WINDOWS = [{ ms: FEEDBACK_WINDOW_MS, max: FEEDBACK_MAX_PER_WINDOW, label: 'hour' }];

    setInterval(() => sweepRateLimit(feedbackRateLimit, FEEDBACK_WINDOW_MS), FEEDBACK_WINDOW_MS).unref?.();

    router.post('/request/:requestId/feedback', async (req, res) => {
        const { requestId } = req.params;
        const { message: feedback } = req.body || {};

        try {
            if (typeof feedback !== 'string' || !feedback.trim()) {
                return res.status(400).json({ error: 'A feedback message is required.' });
            }
            const trimmed = feedback.trim();
            if (Buffer.byteLength(trimmed, 'utf8') > config.USER_FEEDBACK_MAX_BYTES) {
                return res.status(400).json({ error: `Feedback must be under ${config.USER_FEEDBACK_MAX_BYTES} bytes.` });
            }

            const ip = clientIp(req);
            const gate = withinLimit(feedbackRateLimit, ip, FEEDBACK_WINDOWS);
            if (!gate.ok) {
                return res.status(429).json({ error: 'Too many feedback submissions. Please try again later.' });
            }

            const row = await dbGet(db, 'SELECT id, status FROM requests WHERE id = ?', [requestId]);
            if (!row) {
                return res.status(404).json({ error: 'Request not found.' });
            }
            if (!FEEDBACK_ALLOWED_STATUSES.includes(row.status)) {
                return res.status(409).json({ error: 'Feedback can only be left on a request that did not succeed.' });
            }

            await dbRun(
                db,
                'UPDATE requests SET userFeedback = ?, userFeedbackAt = ? WHERE id = ?',
                [trimmed, new Date().toISOString(), requestId]
            );

            gate.record();

            console.log(`[API] Customer feedback recorded for failed request ${requestId} (${trimmed.length} chars).`);
            notifier.notifyCustomerMessage({ requestId, feedback: trimmed }, config);
            res.status(200).json({ success: true, message: 'Thank you — your message has been sent to the operator.' });
        } catch (error) {
            console.error(`Error saving feedback for ${requestId}:`, error);
            res.status(500).json({ error: 'Failed to save feedback.' });
        }
    });

    router.delete('/request/:requestId', optionalApiKey, async (req, res) => {
        const { requestId } = req.params;
        console.log(`DELETE /api/request/${requestId}`);
        try {
            // Never let a cancel destroy the record of a paid request. Doing so would
            // discard the customer's message and refund address — the only record of
            // what their money was for. The cleanup job has the same guard.
            const existing = await dbGet(
                db,
                'SELECT paymentTxId, paymentReceivedSatoshis, opReturnTxId, refundTxId FROM requests WHERE id = ?',
                [requestId]
            );
            if (existing && (existing.paymentTxId || existing.paymentReceivedSatoshis || existing.opReturnTxId || existing.refundTxId)) {
                return res.status(409).json({
                    error: 'This request has an associated payment and cannot be cancelled. Contact support if you need it resolved.',
                });
            }

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
// Exported for unit testing of the intake rules in isolation.
module.exports.validateRequestParams = validateRequestParams;
