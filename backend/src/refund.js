// backend/src/refund.js
//
// Returns funds to the payer when a request has terminally failed.
//
// Before this existed, a failed request simply stopped: the customer's payment stayed
// in the derived address indefinitely while the request sat in `op_return_failed`.
// The refundAddress column existed in the schema but was never written or read.
//
// Safety properties:
//   - Idempotent. A conditional UPDATE acts as a lock, so concurrent callers
//     (retry loop, reconciliation job, admin button) cannot double-spend a refund.
//   - Never refunds a request that has already been fulfilled on-chain.
//   - Refuses rather than guesses when the payer address is unknown.

const bitcoin = require('bitcoinjs-lib');
const chainProviders = require('./chain_providers');
const { dbGet, dbRun } = require('./db_utils');

// Statuses from which a refund may legitimately begin.
const REFUNDABLE_STATUSES = ['op_return_failed', 'refund_failed'];

/**
 * Estimates the vbyte size of a P2WPKH sweep: overhead + n inputs + 1 output.
 */
function estimateRefundVBytes(inputCount) {
    return Math.ceil(10 + 68 * inputCount + 31);
}

async function markRefundFailed(db, requestId, reason) {
    // Writes refundFailureReason, never failureReason: the fulfilment diagnostic is what
    // the retry/refund passes classify against, and clobbering it would strand the row.
    await dbRun(
        db,
        "UPDATE requests SET status = 'refund_failed', refundFailureReason = ? WHERE id = ? AND refundTxId IS NULL",
        [reason, requestId]
    );
    console.error(`[Refund] Request ${requestId} refund failed: ${reason}`);
    return { ok: false, reason };
}

/**
 * Attempts to refund a terminally failed request.
 *
 * @returns {Promise<{ok: true, refundTxId: string, amount: number} | {ok: false, reason: string}>}
 */
async function attemptRefund(request, db, rootNode, config) {
    const requestId = request.id;

    if (!config.REFUND_ENABLED) {
        return { ok: false, reason: 'refunds_disabled' };
    }

    // Never refund something that actually made it on-chain.
    if (request.opReturnTxId) {
        return { ok: false, reason: 'already_fulfilled' };
    }
    if (request.refundTxId) {
        return { ok: false, reason: 'already_refunded' };
    }
    if (!REFUNDABLE_STATUSES.includes(request.status)) {
        return { ok: false, reason: `not_refundable_from_status_${request.status}` };
    }
    if (!request.refundAddress) {
        // We only learn the payer's address from the funding transaction. Older rows
        // predate that capture, so they need manual handling rather than a guess.
        return markRefundFailed(db, requestId, 'no_refund_address_on_record');
    }
    if (!request.derivationPath || !request.address) {
        return markRefundFailed(db, requestId, 'missing_derivation_details');
    }

    // --- Acquire the lock -------------------------------------------------
    // Conditional on refundTxId still being NULL, so only one caller proceeds.
    const lock = await dbRun(
        db,
        `UPDATE requests SET status = 'refund_processing'
         WHERE id = ? AND refundTxId IS NULL AND status IN (${REFUNDABLE_STATUSES.map(() => '?').join(',')})`,
        [requestId, ...REFUNDABLE_STATUSES]
    );
    if (lock.changes === 0) {
        return { ok: false, reason: 'refund_lock_not_acquired' };
    }
    console.log(`[Refund] Lock acquired for ${requestId}. Refunding to ${request.refundAddress}`);

    try {
        const network = config.NETWORK;

        // Validate the destination before doing anything irreversible.
        try {
            bitcoin.address.toOutputScript(request.refundAddress, network);
        } catch (e) {
            return markRefundFailed(db, requestId, `invalid_refund_address: ${e.message}`);
        }

        // --- Gather the funds still sitting at the payment address ---------
        const unspent = await chainProviders.getUnspent(request.address, config);
        if (!unspent.ok) {
            // Provider trouble is transient: put it back so a later pass retries.
            await dbRun(db, "UPDATE requests SET status = 'op_return_failed' WHERE id = ?", [requestId]);
            return { ok: false, reason: `utxo_lookup_failed: ${unspent.reason}` };
        }

        const confirmed = unspent.utxos.filter((u) => u.confirmations > 0);
        if (confirmed.length === 0) {
            return markRefundFailed(db, requestId, 'no_confirmed_funds_to_refund');
        }

        const inputTotal = confirmed.reduce((sum, u) => sum + u.value, 0);
        const feeRate = request.feeRate || config.DEFAULT_FEE_RATE;
        const fee = estimateRefundVBytes(confirmed.length) * feeRate;
        const refundValue = inputTotal - fee;

        console.log(`[Refund] ${requestId}: ${confirmed.length} UTXO(s), total ${inputTotal} sats, fee ${fee}, refunding ${refundValue}`);

        if (refundValue < config.DUST_LIMIT_SATS) {
            // Sending this would create a dust output that relays reject — the exact
            // failure mode this whole change set exists to prevent.
            return markRefundFailed(
                db,
                requestId,
                `refund_below_dust: ${inputTotal} sats minus ${fee} fee leaves ${refundValue}, under dust limit ${config.DUST_LIMIT_SATS}`
            );
        }

        // --- Build and sign -------------------------------------------------
        const keyPair = rootNode.derivePath(request.derivationPath);
        const scriptPubKey = bitcoin.address.toOutputScript(request.address, network);
        const psbt = new bitcoin.Psbt({ network });

        for (const utxo of confirmed) {
            psbt.addInput({
                hash: utxo.txId,
                index: utxo.vout,
                witnessUtxo: { script: scriptPubKey, value: utxo.value },
            });
        }
        psbt.addOutput({ address: request.refundAddress, value: refundValue });

        const signer = {
            publicKey: Buffer.from(keyPair.publicKey),
            network,
            sign: (hash) => Buffer.from(keyPair.sign(hash)),
            signSchnorr: (hash) => Buffer.from(keyPair.signSchnorr(hash)),
        };

        for (let i = 0; i < confirmed.length; i++) {
            psbt.signInput(i, signer);
            const valid = psbt.validateSignaturesOfInput(i, (pubkey, msghash, signature) =>
                keyPair.verify(msghash, signature)
            );
            if (!valid) {
                return markRefundFailed(db, requestId, `signature_validation_failed_on_input_${i}`);
            }
        }

        psbt.finalizeAllInputs();
        const tx = psbt.extractTransaction();
        const txHex = tx.toHex();
        const localTxId = tx.getId();

        // --- Broadcast -------------------------------------------------------
        const broadcast = await chainProviders.broadcastTransaction(txHex, config, localTxId);
        if (!broadcast.ok) {
            if (broadcast.permanent) {
                return markRefundFailed(db, requestId, `refund_broadcast_rejected: ${broadcast.reason}`);
            }
            // Transient: revert so a later pass can try again. No funds moved.
            await dbRun(db, "UPDATE requests SET status = 'op_return_failed' WHERE id = ?", [requestId]);
            return { ok: false, reason: `refund_broadcast_unavailable: ${broadcast.reason}` };
        }

        const refundTxId = broadcast.txId || localTxId;
        await dbRun(
            db,
            "UPDATE requests SET status = 'refunded', refundTxId = ?, refundedAt = ? WHERE id = ?",
            [refundTxId, new Date().toISOString(), requestId]
        );
        console.log(`[Refund] Request ${requestId} refunded ${refundValue} sats to ${request.refundAddress}. TXID: ${refundTxId}`);

        return { ok: true, refundTxId, amount: refundValue };
    } catch (error) {
        // Leave the request refundable rather than stranding it in refund_processing.
        await dbRun(
            db,
            "UPDATE requests SET status = 'refund_failed', refundFailureReason = ? WHERE id = ? AND refundTxId IS NULL",
            [`refund_exception: ${error.message}`, requestId]
        );
        console.error(`[Refund] Exception refunding ${requestId}:`, error);
        return { ok: false, reason: `refund_exception: ${error.message}` };
    }
}

/** Reloads the request row and refunds it. Convenience for callers holding only an id. */
async function refundById(requestId, db, rootNode, config) {
    const request = await dbGet(db, 'SELECT * FROM requests WHERE id = ?', [requestId]);
    if (!request) return { ok: false, reason: 'request_not_found' };
    return attemptRefund(request, db, rootNode, config);
}

module.exports = { attemptRefund, refundById, REFUNDABLE_STATUSES, estimateRefundVBytes };
