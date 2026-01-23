// backend/src/routes/webhook.js
const express = require('express');
const { dbGet, dbRun } = require('../db_utils');
const { fulfillRequest } = require('../request_service');

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

                for (const targetAddress of output.addresses) {
                    const req = await dbGet(
                        db,
                        "SELECT * FROM requests WHERE address = ? AND (status = 'pending_payment' OR status = 'payment_detected')",
                        [targetAddress]
                    );

                    if (req) {
                        console.log(`[Webhook] Found matching request ID ${req.id} for address ${targetAddress}`);
                        
                        const isSufficientAmount = output.value >= req.requiredAmountSatoshis;

                        if (confirmations >= 1 && isSufficientAmount) {
                            console.log(`[Webhook] Payment VALID for request ${req.id}`);
                            await dbRun(
                                db,
                                'UPDATE requests SET status = ?, paymentTxId = ? WHERE id = ? AND (status = ? OR status = ?)',
                                ['payment_confirmed', txHash, req.id, 'pending_payment', 'payment_detected']
                            );
                            paymentProcessedForRequestObject = { ...req, paymentTxId: txHash };
                            break; // Address processed, break inner loop
                        } else if (confirmations === 0 && isSufficientAmount) {
                            console.log(`[Webhook] Unconfirmed payment detected for request ${req.id}`);
                            if (req.status === 'pending_payment') {
                                await dbRun(
                                    db,
                                    'UPDATE requests SET status = ?, paymentTxId = ? WHERE id = ?',
                                    ['payment_detected', txHash, req.id]
                                );
                                console.log(`[Webhook] Request ${req.id} status updated to payment_detected.`);
                            }
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
