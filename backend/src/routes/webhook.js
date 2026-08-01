// backend/src/routes/webhook.js
const express = require('express');
const { dbGet, dbRun } = require('../db_utils');
const { fulfillRequest } = require('../request_service');
const chainProviders = require('../chain_providers');
const notifier = require('../notifier');

/**
 * Resolves the payer's address for a payment transaction, so a failed request can be
 * refunded to whoever paid.
 *
 * IMPORTANT: this endpoint is unauthenticated, so the request body is untrusted input.
 * The address is therefore read from a blockchain provider using only the txid — never
 * from the notification's own `inputs`. Trusting the body would let anyone POST a forged
 * notification and redirect a customer's refund to an address of their choosing.
 *
 * Returns null when it cannot be resolved; the refund path then refuses to guess.
 */
async function resolvePayerAddress(txHash, config) {
    try {
        const result = await chainProviders.getPayerAddress(txHash, config);
        if (result.ok) return result.address;
        console.warn(`[Webhook] Could not resolve payer for ${txHash}: ${result.reason}`);
    } catch (error) {
        console.warn(`[Webhook] Payer lookup threw for ${txHash}: ${error.message}`);
    }
    return null;
}

function createWebhookRouter(db, rootNode, config) {
    const router = express.Router();

    router.post('/payment-notification', async (req, res) => {
        console.log(">>>>>>>>> WEBHOOK /api/webhook/payment-notification ENTERED <<<<<<<<<");
        const notification = req.body;

        try {
            const { hash: txHash, confirmations, outputs } = notification;
            if (!txHash || confirmations === undefined || !outputs) {
                return res.status(200).send('Webhook received but payload invalid.');
            }
            console.log(`[Webhook] Processing TX ${txHash}, Confirmations: ${confirmations}`);

            let paymentProcessedForRequestObject = null;

            for (const output of outputs) {
                if (!output.addresses || !Array.isArray(output.addresses)) continue;

                for (const paidAddress of output.addresses) {
                    // NOTE: deliberately not named `req` — that would shadow the Express
                    // request object this handler is closed over.
                    const matched = await dbGet(
                        db,
                        "SELECT * FROM requests WHERE address = ? AND (status = 'pending_payment' OR status = 'payment_detected')",
                        [paidAddress]
                    );

                    if (matched) {
                        console.log(`[Webhook] Found matching request ID ${matched.id} for address ${paidAddress}`);

                        const isSufficientAmount = output.value >= matched.requiredAmountSatoshis;
                        // Resolved from the chain, not from this untrusted request body.
                        const payerAddress = await resolvePayerAddress(txHash, config);

                        if (confirmations >= 1 && isSufficientAmount) {
                            console.log(`[Webhook] Payment VALID for request ${matched.id}`);
                            await dbRun(
                                db,
                                `UPDATE requests
                                 SET status = ?, paymentTxId = ?, paymentReceivedSatoshis = ?,
                                     paymentConfirmationCount = ?, paymentConfirmedAt = ?,
                                     refundAddress = COALESCE(refundAddress, ?)
                                 WHERE id = ? AND (status = ? OR status = ?)`,
                                [
                                    'payment_confirmed', txHash, output.value,
                                    confirmations, new Date().toISOString(),
                                    payerAddress,
                                    matched.id, 'pending_payment', 'payment_detected'
                                ]
                            );
                            paymentProcessedForRequestObject = {
                                ...matched,
                                paymentTxId: txHash,
                                paymentReceivedSatoshis: output.value,
                                refundAddress: matched.refundAddress || payerAddress,
                            };
                            notifier.notifyPaymentReceived({
                                requestId: matched.id,
                                amount: output.value,
                                message: matched.message,
                            }, config);
                            break; // Address processed, break inner loop
                        } else if (confirmations === 0 && isSufficientAmount) {
                            console.log(`[Webhook] Unconfirmed payment detected for request ${matched.id}`);
                            if (matched.status === 'pending_payment') {
                                await dbRun(
                                    db,
                                    `UPDATE requests
                                     SET status = ?, paymentTxId = ?, paymentReceivedSatoshis = ?,
                                         paymentConfirmationCount = ?, refundAddress = COALESCE(refundAddress, ?)
                                     WHERE id = ?`,
                                    ['payment_detected', txHash, output.value, confirmations, payerAddress, matched.id]
                                );
                                console.log(`[Webhook] Request ${matched.id} status updated to payment_detected.`);
                            }
                        } else if (!isSufficientAmount) {
                            // Underpayment: never silently swallow it. Record what arrived
                            // so it shows up in the admin panel and reconciliation.
                            console.warn(
                                `[Webhook] UNDERPAYMENT for request ${matched.id}: received ${output.value}, required ${matched.requiredAmountSatoshis}`
                            );
                            await dbRun(
                                db,
                                `UPDATE requests
                                 SET paymentTxId = COALESCE(paymentTxId, ?), paymentReceivedSatoshis = ?,
                                     paymentConfirmationCount = ?, refundAddress = COALESCE(refundAddress, ?),
                                     failureReason = ?
                                 WHERE id = ?`,
                                [
                                    txHash, output.value, confirmations, payerAddress,
                                    `underpaid: received ${output.value} sats, required ${matched.requiredAmountSatoshis}`,
                                    matched.id
                                ]
                            );
                        }
                    }
                }
                if (paymentProcessedForRequestObject) break; // Request found, break outer loop
            }

            if (paymentProcessedForRequestObject) {
                // Use shared fulfillRequest service
                const result = await fulfillRequest(paymentProcessedForRequestObject, db, rootNode, config);
                
                if (result.success) {
                    console.log(`[Webhook] OP_RETURN successful for ${paymentProcessedForRequestObject.id}: ${result.opReturnTxId}`);
                } else if (result.error === 'Lock not acquired') {
                    console.log(`[Webhook] Lock for ${paymentProcessedForRequestObject.id} was already taken.`);
                } else {
                    console.log(`[Webhook] OP_RETURN failed for ${paymentProcessedForRequestObject.id}: ${result.error}`);
                }
            } else {
                console.log("[Webhook] No new, actionable request identified in this event.");
            }

            res.status(200).send('Webhook Notification Processed.');
        } catch (error) {
            console.error("!!! CATCH BLOCK ERROR processing webhook !!!", error);
            res.status(200).send('Webhook received but internal error occurred.');
        }
    });

    return router;
}

module.exports = createWebhookRouter;
