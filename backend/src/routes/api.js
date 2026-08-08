// backend/src/routes/api.js
const express = require('express');
const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const { dbGet, dbRun } = require('../db_utils');
const { fulfillRequest, deleteRequest } = require('../request_service');
const notifier = require('../notifier');
const txSizing = require('../tx_sizing');
const events = require('../request_events');
const wall = require('../wall');
const qr = require('../qr');

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
 * The fields GET /request-status/:requestId may return.
 *
 * This endpoint is public — `optionalApiKey` lets any caller through — and the request id
 * is therefore a bearer capability. It used to answer with `{ ...row }` over a
 * `SELECT *`, which handed anyone holding that id the wallet's `derivationPath` and
 * `index` (the seed's structure), the raw signed `opReturnTxHex`, the BlockCypher hook id,
 * and the payer's `refundAddress`.
 *
 * A whitelist rather than a blacklist, so a column added later is private by default. That
 * matters immediately: `hiddenByAdmin` is a moderation judgement about a customer's words
 * and would otherwise have become publicly readable the moment the column existed, with no
 * code written to expose it.
 */
const PUBLIC_REQUEST_FIELDS = [
    'id', 'status', 'createdAt', 'message',
    'address', 'requiredAmountSatoshis',
    'targetAddress', 'amountToSend', 'feeRate',
    'paymentTxId', 'paymentReceivedSatoshis', 'paymentConfirmationCount', 'paymentConfirmedAt',
    'opReturnTxId', 'opReturnConfirmedAt', 'opReturnBlockHeight',
    'failureReason', 'attemptCount',
    'refundTxId', 'refundedAt', 'refundFailureReason',
    'userFeedback', 'userFeedbackAt',
    // The customer's own choice, so they can see it was recorded. `hiddenByAdmin` is
    // deliberately absent — see above.
    'isPublic', 'publicAt',
    'archivedAt', 'archivedReason',
];

function publicRequestView(row) {
    const view = {};
    for (const field of PUBLIC_REQUEST_FIELDS) {
        if (row[field] !== undefined) view[field] = row[field];
    }
    return view;
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

    /**
     * GET /api/wall?limit=50 — the messages customers chose to show publicly.
     *
     * Public, unauthenticated, and the only endpoint that serves one stranger's words to
     * another. The query and the reasoning behind every term in it live in wall.js.
     *
     * Not rate limited, deliberately. The intake limiter exists to bound permanent wallet
     * -index burn and BlockCypher webhook allowance; sharing its bucket would let a
     * visitor who merely loaded the homepage lock themselves out of creating an order.
     * This endpoint burns nothing: it is a cached read of at most 100 indexed rows and
     * never touches the chain. The 10-second cache is the bound.
     */
    router.get('/wall', async (req, res) => {
        try {
            const { messages, cachedAt } = await wall.listPublicMessages(db, req.query.limit);
            // Public and cached, so let the browser and Cloudflare hold it too.
            res.setHeader('Cache-Control', 'public, max-age=10');
            res.status(200).json({ messages, cachedAt });
        } catch (error) {
            console.error('Error building the public wall:', error.message);
            res.status(500).json({ error: 'Could not load the wall.' });
        }
    });

    /**
     * GET /api/payment-qr.svg?requestId=… — a scannable BIP21 code for an open order.
     *
     * Deliberately NOT modelled on the admin /api/admin/wallet/qr.svg, which accepts an
     * arbitrary `?address=` matching a loose shape check. That is safe only because it
     * sits behind requireAdmin. Copied to a public route it would be two things we must
     * not ship: an open QR generator serving codes from satwire.io, and an address oracle
     * — anyone could test candidate addresses against our wallet and cluster the seed.
     *
     * So: the request id only, which the customer already holds, and the address, amount
     * and label all come from the row. A caller-supplied amount would let someone hand a
     * victim a correct-address/wrong-amount code, and a short payment never satisfies the
     * `>= requiredAmountSatoshis` check — the order would simply never fulfil. A
     * caller-supplied label is text the payer's wallet displays at signing time.
     *
     * Pure DB read plus a CPU render. No chain lookup: this is fetched on every render of
     * a pending order, and the BlockCypher quota belongs to the webhooks.
     */
    router.get('/payment-qr.svg', async (req, res) => {
        const requestId = String(req.query.requestId || '').trim();
        try {
            if (!requestId) {
                return res.status(400).json({ error: 'A requestId is required.' });
            }

            const row = await dbGet(
                db,
                'SELECT id, address, requiredAmountSatoshis, status, archivedAt, webhooksRetiredAt FROM requests WHERE id = ?',
                [requestId]
            );
            if (!row) {
                return res.status(404).json({ error: 'Request not found.' });
            }

            // Never render a payable code for an address nothing is watching.
            //
            // Both guards are needed and they fire at different times. Webhooks are
            // retired at 62 hours; archiving happens at 7 days. In the 4.4 days between,
            // the row still reads 'pending_payment' with archivedAt NULL, and the only
            // thing that would notice a payment is the customer's own status polling —
            // which requires the customer to still have the tab open. A QR code is
            // precisely the artifact you hand to somebody else to pay, and that person is
            // not the one whose browser is polling.
            if (row.archivedAt || row.webhooksRetiredAt) {
                return res.status(410).json({ error: 'This request is no longer open for payment.' });
            }
            if (row.status !== 'pending_payment' && row.status !== 'payment_detected') {
                return res.status(409).json({ error: 'This request is not awaiting payment.' });
            }

            const uri = qr.buildPaymentUri(row.address, {
                amountSats: row.requiredAmountSatoshis,
                label: 'SatWire',
            });
            // toSvg clamps scale itself (2..20), so the query value can pass straight in.
            const svg = qr.toSvg(uri, { scale: req.query.scale });

            res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
            // Immutable for a given request: the address and amount never change once
            // quoted. Served as an <img src>, so without this it is re-rendered on every
            // repaint — the endpoint would be its own amplifier.
            res.setHeader('Cache-Control', 'public, max-age=300');
            res.setHeader('X-Payment-Uri', uri);
            res.send(svg);
        } catch (error) {
            // Fixed string, unlike the admin route, which interpolates error.message. On a
            // public endpoint that leaks internals; the detail goes to the log instead.
            console.error(`[API] Payment QR failed for ${requestId}:`, error.message);
            res.status(500).json({ error: 'Could not draw the QR code.' });
        }
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
        const { message, targetAddress, feeRate, amountToSend, isPublic } = req.body;

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

            // Deliberately NOT in validateRequestParams. That function guards the money:
            // everything it checks changes the transaction or the quote, and it runs before
            // an address is issued for exactly that reason. Wall visibility changes neither
            // — it cannot make a transaction unbroadcastable — so mixing it in would blur
            // what that guard is for. Type-checked here instead, and rejected rather than
            // coerced: `"false"` and `0` are things a caller might send meaning "no", and
            // quietly reading either as truthy would publish someone's words against their
            // intent.
            if (isPublic !== undefined && isPublic !== null && typeof isPublic !== 'boolean') {
                return res.status(400).json({ error: 'isPublic must be true or false.' });
            }
            const wantsPublic = isPublic === true;

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

            // Immediately after the INSERT and BEFORE registerWebhook, which awaits two
            // network calls with a deliberate 5-second sleep between them
            // (webhook_manager.js). Writing the customer's choice on the far side of that
            // await would leave a 5-10 second window in which a crash or a restart loses
            // it silently — the order still completes, the message still publishes, and it
            // simply never appears on the wall, with nothing to reconcile against.
            //
            // Kept out of queue.js rather than threaded through its 7-argument positional
            // signature: the INSERT there is the only one in the tree and every other
            // caller of it is a money path. A separate UPDATE keeps this feature entirely
            // outside the quoting code.
            // Written on BOTH branches, never only on opt-in. The production database
            // carries a legacy `isPublic INTEGER DEFAULT 1` column that our migration
            // cannot redefine (see wall.js), and queue.js's INSERT does not name the
            // column — so a row is born isPublic = 1. Setting it only when the customer
            // says yes would publish everyone who said no.
            await dbRun(
                db,
                'UPDATE requests SET isPublic = ?, publicAt = ?, publicSource = ? WHERE id = ?',
                [
                    wantsPublic ? 1 : 0,
                    wantsPublic ? new Date().toISOString() : null,
                    wantsPublic ? 'customer' : null,
                    result.newRequestId,
                ]
            );
            if (wantsPublic) {
                events.record(db, result.newRequestId, events.KINDS.WALL_OPT_IN, 'customer chose to show this on the wall');
            }

            events.record(db, result.newRequestId, events.KINDS.CREATED, `${Buffer.byteLength(message, 'utf8')} bytes, ${feeRate || config.DEFAULT_FEE_RATE} sat/vB, quote ${result.requiredAmountSatoshis} sats${targetAddress ? `, recipient ${targetAddress}` : ''}`);

            const webhookManager = require('../webhook_manager');
            const hookId = await webhookManager.registerWebhook(result.address, config);
            if (hookId) {
                db.run('UPDATE requests SET blockcypherHookId = ? WHERE id = ?', [hookId, result.newRequestId]);
                console.log(`Successfully updated hook ID ${hookId} for request ${result.newRequestId}`);
                events.record(db, result.newRequestId, events.KINDS.WEBHOOKS_REGISTERED, hookId);
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
                // Echoed back so the caller can confirm what was actually recorded rather
                // than assuming its own request body was honoured.
                isPublic: wantsPublic,
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

            // An archived order must never be presentable as payable. `status` is left
            // untouched by archiving, so without this the response would hand back
            // `pending_payment` together with the payment address of an order nobody is
            // watching any more — inviting a payment into a dead address. Reporting a
            // distinct status also removes the PAY button on already-open tabs with no
            // frontend deploy, because the button only renders for known live statuses.
            //
            // The address and the amount are withheld for the same reason.
            if (row.archivedAt) {
                // An archived request is USUALLY dead — but not always. An operator can
                // force-fulfil one (routes/admin.js, with a second confirmation), and the
                // refund pass deliberately still covers archived rows. Withholding the
                // outcome here left a customer whose withdrawn order was published, or
                // refunded, staring at "Cancelled" forever with no way to learn either.
                //
                // The address and the amount stay withheld — those are what this branch
                // exists to suppress, so the order can never be presented as payable.
                return res.status(200).json({
                    id: row.id,
                    status: 'archived',
                    archivedAt: row.archivedAt,
                    archivedReason: row.archivedReason,
                    createdAt: row.createdAt,
                    message: row.message,
                    opReturnTxId: row.opReturnTxId,
                    opReturnConfirmedAt: row.opReturnConfirmedAt,
                    refundTxId: row.refundTxId,
                    error: row.opReturnTxId
                        ? 'This request was withdrawn, but it had already been paid and was published.'
                        : row.refundTxId
                            ? 'This request was cancelled and your payment was refunded.'
                            : row.archivedReason === 'cancelled_by_customer'
                                ? 'This request was cancelled.'
                                : 'This request expired without payment. Please create a new one.',
                });
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

            const responseBody = publicRequestView(row);
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

            events.record(db, requestId, events.KINDS.FEEDBACK, trimmed);
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
// Exported so the harness can assert on exactly what a public status poll may reveal.
module.exports.PUBLIC_REQUEST_FIELDS = PUBLIC_REQUEST_FIELDS;
module.exports.publicRequestView = publicRequestView;
