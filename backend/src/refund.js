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
const notifier = require('./notifier');
const txSizing = require('./tx_sizing');

// Statuses from which an AUTOMATIC refund may begin.
//
// Deliberately excludes pending_payment/payment_detected: an underpaid request is still
// waiting, and the customer may yet top it up. Auto-refunding it would race that top-up.
// An operator can still refund those explicitly via the admin route, which passes
// options.allowStatuses.
const REFUNDABLE_STATUSES = ['op_return_failed', 'refund_failed'];

// Statuses an operator may refund from by hand. Covers underpayments, which hold real
// customer money but never reach a failed state on their own.
const OPERATOR_REFUNDABLE_STATUSES = [
    ...REFUNDABLE_STATUSES,
    'pending_payment',
    'payment_detected',
    'payment_confirmed',
];

/**
 * Estimates the vbyte size of a P2WPKH sweep: overhead + n inputs + 1 output.
 *
 * The refund goes to whatever address the payer sent from, which is frequently not
 * P2WPKH — the four refunds on 2026-08-06 all went to P2SH addresses. Callers pass that
 * output's real size; the 31-byte default is a P2WPKH output, kept so the existing
 * single-argument callers and the unit harness still work.
 *
 * The overhead is 10.5, not 10: 4 version + 0.5 segwit marker/flag + 1 input count
 * + 1 output count + 4 locktime. Rounding it down put the four refunds above at
 * 1.96 sat/vB against a floor that is supposed to be 2.
 */
function estimateRefundVBytes(inputCount, outputVBytes = 31) {
    return Math.ceil(10.5 + 68 * inputCount + outputVBytes);
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
async function attemptRefund(request, db, rootNode, config, options = {}) {
    const requestId = request.id;
    // Operator-initiated refunds may start from a wider set of statuses (see
    // OPERATOR_REFUNDABLE_STATUSES) because a human has decided the request is dead.
    const allowedStatuses = options.allowStatuses || REFUNDABLE_STATUSES;

    if (!config.REFUND_ENABLED && !options.force) {
        return { ok: false, reason: 'refunds_disabled' };
    }

    // Never refund something that actually made it on-chain.
    if (request.opReturnTxId) {
        return { ok: false, reason: 'already_fulfilled' };
    }
    if (request.refundTxId) {
        return { ok: false, reason: 'already_refunded' };
    }
    if (!allowedStatuses.includes(request.status)) {
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
    // lastAttemptAt is stamped so reconcile.js can distinguish a genuinely abandoned
    // refund lock from one taken moments ago.
    const lock = await dbRun(
        db,
        `UPDATE requests SET status = 'refund_processing', lastAttemptAt = ?
         WHERE id = ? AND refundTxId IS NULL AND opReturnTxId IS NULL
           AND status IN (${allowedStatuses.map(() => '?').join(',')})`,
        [new Date().toISOString(), requestId, ...allowedStatuses]
    );
    if (lock.changes === 0) {
        return { ok: false, reason: 'refund_lock_not_acquired' };
    }
    console.log(`[Refund] Lock acquired for ${requestId}. Refunding to ${request.refundAddress}`);

    try {
        const network = config.NETWORK;

        // Validate the destination before doing anything irreversible. The script is kept
        // so the fee and the dust floor below are both sized against the address we are
        // actually paying, rather than an assumed P2WPKH one.
        let refundScript;
        try {
            refundScript = bitcoin.address.toOutputScript(request.refundAddress, network);
        } catch (e) {
            return markRefundFailed(db, requestId, `invalid_refund_address: ${e.message}`);
        }

        // --- Gather the funds still sitting at the payment address ---------
        const unspent = await chainProviders.getUnspent(request.address, config);
        if (!unspent.ok) {
            // Provider trouble is transient: restore the status we found it in so a later
            // pass can retry. Forcing 'op_return_failed' here would mislabel an
            // operator-initiated refund of a still-pending or underpaid request.
            await dbRun(db, 'UPDATE requests SET status = ? WHERE id = ? AND refundTxId IS NULL', [request.status, requestId]);
            return { ok: false, reason: `utxo_lookup_failed: ${unspent.reason}` };
        }

        const confirmed = unspent.utxos.filter((u) => u.confirmations > 0);
        if (confirmed.length === 0) {
            return markRefundFailed(db, requestId, 'no_confirmed_funds_to_refund');
        }

        const inputTotal = confirmed.reduce((sum, u) => sum + u.value, 0);
        // Same floor as the fulfilment path: a refund paying the bare minimum relay fee
        // is rejected as non-standard, which would leave the customer unpaid twice over.
        const feeRate = Math.max(
            request.feeRate || config.DEFAULT_FEE_RATE,
            config.MIN_EFFECTIVE_FEE_RATE || 2
        );
        const fee = estimateRefundVBytes(confirmed.length, txSizing.outputVBytes(refundScript)) * feeRate;
        const refundValue = inputTotal - fee;

        console.log(`[Refund] ${requestId}: ${confirmed.length} UTXO(s), total ${inputTotal} sats, fee ${fee}, refunding ${refundValue}`);

        const refundDustLimit = txSizing.dustLimitForScript(refundScript, config);
        if (refundValue < refundDustLimit) {
            // Sending this would create a dust output that relays reject — the exact
            // failure mode this whole change set exists to prevent.
            return markRefundFailed(
                db,
                requestId,
                `refund_below_dust: ${inputTotal} sats minus ${fee} fee leaves ${refundValue}, under the ${refundDustLimit} sat dust limit for ${request.refundAddress}`
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
        psbt.addOutput({ script: refundScript, value: refundValue });

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
            // Transient: revert to the status we found it in so a later pass can try
            // again. No funds moved.
            await dbRun(db, 'UPDATE requests SET status = ? WHERE id = ? AND refundTxId IS NULL', [request.status, requestId]);
            return { ok: false, reason: `refund_broadcast_unavailable: ${broadcast.reason}` };
        }

        const refundTxId = broadcast.txId || localTxId;
        await dbRun(
            db,
            "UPDATE requests SET status = 'refunded', refundTxId = ?, refundedAt = ? WHERE id = ?",
            [refundTxId, new Date().toISOString(), requestId]
        );
        console.log(`[Refund] Request ${requestId} refunded ${refundValue} sats to ${request.refundAddress}. TXID: ${refundTxId}`);
        notifier.notifyRefunded({
            requestId,
            amount: refundValue,
            refundTxId,
            refundAddress: request.refundAddress,
        }, config);

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
async function refundById(requestId, db, rootNode, config, options = {}) {
    const request = await dbGet(db, 'SELECT * FROM requests WHERE id = ?', [requestId]);
    if (!request) return { ok: false, reason: 'request_not_found' };
    return attemptRefund(request, db, rootNode, config, options);
}

module.exports = {
    attemptRefund,
    refundById,
    REFUNDABLE_STATUSES,
    OPERATOR_REFUNDABLE_STATUSES,
    estimateRefundVBytes,
};
