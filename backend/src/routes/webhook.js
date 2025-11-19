// backend/src/routes/webhook.js
const express = require('express');
const opReturnCreator = require('../op_return_creator');

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
                    const req = await new Promise((resolve, reject) => {
                        db.get("SELECT * FROM requests WHERE address = ? AND (status = 'pending_payment' OR status = 'payment_detected')", [targetAddress], (err, row) => err ? reject(err) : resolve(row));
                    });

                    if (req) {
                        console.log(`[Webhook] Found matching request ID ${req.id} for address ${targetAddress}`);
                        if (confirmations >= 1 && output.value >= req.requiredAmountSatoshis) {
                            console.log(`[Webhook] Payment VALID for request ${req.id}`);
                            await new Promise((resolve, reject) => {
                                db.run('UPDATE requests SET status = ?, paymentTxId = ? WHERE id = ? AND (status = ? OR status = ?)',
                                    ['payment_confirmed', txHash, req.id, 'pending_payment', 'payment_detected'], (err) => err ? reject(err) : resolve());
                            });
                            paymentProcessedForRequestObject = { ...req, paymentTxId: txHash };
                            break; // Address processed, break inner loop
                        }
                    }
                }
                if (paymentProcessedForRequestObject) break; // Request found, break outer loop
            }

            if (paymentProcessedForRequestObject) {
                const lockAcquired = await new Promise((resolve, reject) => {
                    db.run("UPDATE requests SET status = 'processing_op_return' WHERE id = ? AND status = 'payment_confirmed'", [paymentProcessedForRequestObject.id], function(err) {
                        if (err) return reject(err);
                        resolve(this.changes > 0);
                    });
                });

                if (lockAcquired) {
                    console.log(`[Webhook] Lock ACQUIRED for ${paymentProcessedForRequestObject.id}. Triggering OP_RETURN.`);
                    let finalOpStatus = 'op_return_failed';
                    let opReturnResult = null;
                    try {
                        opReturnResult = await opReturnCreator.createOpReturnTransaction(paymentProcessedForRequestObject, rootNode, config.NETWORK, { BLOCKCYPHER_API_BASE: config.BLOCKCYPHER_API_BASE, BLOCKCYPHER_TOKEN: config.BLOCKCYPHER_TOKEN });
                        if (opReturnResult && opReturnResult.opReturnTxId) {
                            finalOpStatus = 'op_return_broadcasted';
                        }
                    } catch (opReturnError) {
                        console.error(`[Webhook] CATCH during OP_RETURN for ${paymentProcessedForRequestObject.id}:`, opReturnError);
                    }
                    
                    await new Promise((resolve, reject) => {
                        db.run("UPDATE requests SET status = ?, opReturnTxId = ?, opReturnTxHex = ? WHERE id = ?", [finalOpStatus, opReturnResult?.opReturnTxId, opReturnResult?.signedTxHex, paymentProcessedForRequestObject.id], (err) => err ? reject(err) : resolve());
                    });
                    console.log(`[Webhook] DB updated: Request ${paymentProcessedForRequestObject.id} status changed to ${finalOpStatus}.`);
                } else {
                    console.log(`[Webhook] Lock for ${paymentProcessedForRequestObject.id} was already taken.`);
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
