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

/**
 * Confirms against the chain that `txHash` really pays `address`, and returns the value
 * and confirmation count a provider reports — never the ones in the notification body.
 *
 * `resolvePayerAddress` above already refused to trust the body's `inputs`, but the rest
 * of the handler still took `outputs`, `output.value` and `confirmations` on faith. This
 * endpoint is unauthenticated and its callback URL is a fixed, guessable path
 * (webhook_manager.js builds it with no secret), so a forged POST naming the address of
 * any live request could mark it paid at an arbitrary amount and, because `refundAddress`
 * is written on the same statement, point the refund at an address of the sender's
 * choosing. Fulfilment would then fail `utxo_lookup_failed` — which is not permanent — so
 * the reconciliation pass would retry to exhaustion and auto-refund, sweeping whatever
 * that address actually held to the forger.
 *
 * Everything the handler acts on is therefore read from a provider. A notification that
 * cannot be verified is ignored: the customer's own status polling does its own chain
 * check (routes/api.js self-heal), so a real payment is still picked up.
 *
 * @returns {Promise<{ok: true, value: number, vout: number, confirmations: number}
 *   | {ok: false, reason: string}>}
 */
async function verifyPaymentOnChain(txHash, address, config) {
    // Proves the transaction genuinely pays this address, and yields the true value.
    // Works even once the output has been spent, unlike an unspent-set lookup.
    const output = await chainProviders.findUtxoForAddress(txHash, address, config);
    if (!output.ok) {
        return { ok: false, reason: output.reason };
    }

    // getTxOutputs carries no confirmation count, so read it from the address's unspent
    // set. An output missing from it is either unconfirmed or already spent; a request
    // still in pending_payment/payment_detected has not been fulfilled, so for the rows
    // this handler acts on, absent means not yet confirmed.
    let confirmations = 0;
    const unspent = await chainProviders.getUnspent(address, config);
    if (unspent.ok) {
        const match = (unspent.utxos || []).find((u) => u.txId === txHash && u.vout === output.vout);
        if (match) confirmations = match.confirmations || 0;
    } else {
        console.warn(`[Webhook] Could not read unspent set for ${address}: ${unspent.reason}. Treating as unconfirmed.`);
    }

    return { ok: true, value: output.value, vout: output.vout, confirmations };
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

                        // Nothing below this point may use the body's numbers. See
                        // verifyPaymentOnChain: the body is attacker-controlled.
                        const verified = await verifyPaymentOnChain(txHash, paidAddress, config);
                        if (!verified.ok) {
                            console.warn(
                                `[Webhook] IGNORING notification for ${matched.id}: could not verify that ${txHash} pays ` +
                                `${paidAddress} — ${verified.reason}. Body claimed ${output.value} sats, ${confirmations} conf.`
                            );
                            continue;
                        }
                        if (verified.value !== output.value || verified.confirmations !== confirmations) {
                            console.warn(
                                `[Webhook] Notification for ${matched.id} disagrees with the chain: body said ` +
                                `${output.value} sats/${confirmations} conf, chain says ${verified.value} sats/` +
                                `${verified.confirmations} conf. Using the chain.`
                            );
                        }
                        const paidValue = verified.value;
                        const chainConfirmations = verified.confirmations;

                        const isSufficientAmount = paidValue >= matched.requiredAmountSatoshis;
                        // Resolved from the chain, not from this untrusted request body.
                        const payerAddress = await resolvePayerAddress(txHash, config);

                        if (chainConfirmations >= 1 && isSufficientAmount) {
                            console.log(`[Webhook] Payment VALID for request ${matched.id}`);
                            await dbRun(
                                db,
                                `UPDATE requests
                                 SET status = ?, paymentTxId = ?, paymentReceivedSatoshis = ?,
                                     paymentConfirmationCount = ?, paymentConfirmedAt = ?,
                                     refundAddress = COALESCE(refundAddress, ?)
                                 WHERE id = ? AND (status = ? OR status = ?)`,
                                [
                                    'payment_confirmed', txHash, paidValue,
                                    chainConfirmations, new Date().toISOString(),
                                    payerAddress,
                                    matched.id, 'pending_payment', 'payment_detected'
                                ]
                            );
                            paymentProcessedForRequestObject = {
                                ...matched,
                                paymentTxId: txHash,
                                paymentReceivedSatoshis: paidValue,
                                refundAddress: matched.refundAddress || payerAddress,
                            };
                            notifier.notifyPaymentReceived({
                                requestId: matched.id,
                                amount: paidValue,
                                message: matched.message,
                            }, config);
                            break; // Address processed, break inner loop
                        } else if (chainConfirmations === 0 && isSufficientAmount) {
                            console.log(`[Webhook] Unconfirmed payment detected for request ${matched.id}`);
                            if (matched.status === 'pending_payment') {
                                await dbRun(
                                    db,
                                    `UPDATE requests
                                     SET status = ?, paymentTxId = ?, paymentReceivedSatoshis = ?,
                                         paymentConfirmationCount = ?, refundAddress = COALESCE(refundAddress, ?)
                                     WHERE id = ?`,
                                    ['payment_detected', txHash, paidValue, chainConfirmations, payerAddress, matched.id]
                                );
                                console.log(`[Webhook] Request ${matched.id} status updated to payment_detected.`);
                            }
                        } else if (!isSufficientAmount) {
                            // Underpayment: never silently swallow it. Record what arrived
                            // so it shows up in the admin panel and reconciliation.
                            console.warn(
                                `[Webhook] UNDERPAYMENT for request ${matched.id}: received ${paidValue}, required ${matched.requiredAmountSatoshis}`
                            );
                            await dbRun(
                                db,
                                `UPDATE requests
                                 SET paymentTxId = COALESCE(paymentTxId, ?), paymentReceivedSatoshis = ?,
                                     paymentConfirmationCount = ?, refundAddress = COALESCE(refundAddress, ?),
                                     failureReason = ?
                                 WHERE id = ?`,
                                [
                                    txHash, paidValue, chainConfirmations, payerAddress,
                                    `underpaid: received ${paidValue} sats, required ${matched.requiredAmountSatoshis}`,
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
