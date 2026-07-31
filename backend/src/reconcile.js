// backend/src/reconcile.js
//
// Periodic safety net. Nothing here is the primary path — the webhook is — but every
// primary path can drop a request: a webhook that never arrives, a provider outage
// mid-broadcast, a process restart while a request holds the processing lock.
//
// Without this job a dropped request stays dropped forever. That is exactly how a paid
// request went unfulfilled and unnoticed for 66 days.
//
// Each pass:
//   1. Unsticks requests abandoned mid-fulfilment (crash or restart while locked).
//   2. Retries non-permanent failures that still have attempts left.
//   3. Refunds terminally failed requests that still hold customer funds.
//   4. Reports anything holding money with nothing delivered.

const { dbAll, dbRun } = require('./db_utils');
const { fulfillRequest } = require('./request_service');
const { attemptRefund } = require('./refund');
const chainProviders = require('./chain_providers');

// How long a request may sit in processing_op_return before we assume the worker died.
const STUCK_LOCK_MS = 30 * 60 * 1000;

/**
 * Failure reasons that no amount of retrying will fix. Mirrors the permanent set in
 * op_return_creator, matched by prefix since failureReason carries a detail suffix.
 */
const PERMANENT_PREFIXES = [
    'invalid_message',
    'missing_payment_details',
    'insufficient_payment',
    'invalid_target_address',
    'change_derivation_failed',
    'key_derivation_failed',
    'signature_validation_failed',
    'broadcast_rejected',
    'fee_below_relay_minimum',
    'inputs_already_spent',
];

function isPermanentReason(reason) {
    if (!reason) return false;
    return PERMANENT_PREFIXES.some((p) => String(reason).startsWith(p));
}

/** Failures where the money has already left the payment address, so no refund is possible. */
function isNoRefundReason(reason) {
    return !!reason && String(reason).startsWith('inputs_already_spent');
}

async function unstickAbandonedLocks(db) {
    const cutoff = new Date(Date.now() - STUCK_LOCK_MS).toISOString();

    // fulfillRequest stamps lastAttemptAt when it takes the lock, so a NULL here means a
    // row written by an older build. Fall back to createdAt rather than treating NULL as
    // "infinitely old", which would steal a lock taken seconds ago by a live worker.
    const fulfilment = await dbRun(
        db,
        `UPDATE requests SET status = 'payment_confirmed'
         WHERE status = 'processing_op_return'
           AND opReturnTxId IS NULL
           AND refundTxId IS NULL
           AND COALESCE(lastAttemptAt, createdAt) < ?`,
        [cutoff]
    );
    if (fulfilment.changes > 0) {
        console.warn(`[Reconcile] Released ${fulfilment.changes} abandoned fulfilment lock(s).`);
    }

    // refund_processing is set by attemptRefund. If the process dies between taking that
    // lock and recording the result, nothing else in the system can ever move the row —
    // it would hold customer funds forever. Release it back to a refundable state.
    // Safe because attemptRefund re-checks the chain for unspent funds before spending,
    // so a refund that actually did broadcast will find nothing left to send.
    const refunds = await dbRun(
        db,
        `UPDATE requests SET status = 'op_return_failed'
         WHERE status = 'refund_processing'
           AND refundTxId IS NULL
           AND opReturnTxId IS NULL
           AND COALESCE(lastAttemptAt, createdAt) < ?`,
        [cutoff]
    );
    if (refunds.changes > 0) {
        console.warn(`[Reconcile] Released ${refunds.changes} abandoned refund lock(s).`);
    }

    return fulfilment.changes + refunds.changes;
}

/**
 * Drives requests that are paid and waiting but that no other path will pick up.
 *
 * This covers two cases that would otherwise be permanent dead ends:
 *   - a lock just released by unstickAbandonedLocks, and
 *   - a payment confirmed by the webhook where fulfilment never started (crash, restart).
 * Nothing else in the system polls 'payment_confirmed'; the webhook only drives a
 * request in the same execution in which it observes the payment.
 */
async function drivePaidRequests(db, rootNode, config) {
    const maxAttempts = config.MAX_FULFILL_ATTEMPTS || 3;
    const candidates = await dbAll(
        db,
        `SELECT * FROM requests
         WHERE status = 'payment_confirmed'
           AND paymentTxId IS NOT NULL
           AND opReturnTxId IS NULL
           AND refundTxId IS NULL
           AND COALESCE(attemptCount, 0) < ?`,
        [maxAttempts]
    );

    let driven = 0;
    for (const request of candidates) {
        console.log(`[Reconcile] Driving paid-but-unfulfilled request ${request.id}`);
        const result = await fulfillRequest(request, db, rootNode, config);
        if (result.error === 'Lock not acquired') continue;
        driven++;
        if (result.success) {
            console.log(`[Reconcile] Fulfilled ${request.id}: ${result.opReturnTxId}`);
        }
    }
    return driven;
}

async function retryFailedRequests(db, rootNode, config) {
    const maxAttempts = config.MAX_FULFILL_ATTEMPTS || 3;

    const candidates = await dbAll(
        db,
        `SELECT * FROM requests
         WHERE status = 'op_return_failed'
           AND opReturnTxId IS NULL
           AND refundTxId IS NULL
           AND paymentTxId IS NOT NULL
           AND COALESCE(attemptCount, 0) < ?`,
        [maxAttempts]
    );

    let retried = 0;
    for (const request of candidates) {
        if (isPermanentReason(request.failureReason)) {
            // Not retryable — the refund pass below will handle it.
            continue;
        }

        // Before rebuilding a transaction, confirm the payment output has not already
        // been spent. If it has, an earlier attempt almost certainly did confirm and we
        // recorded it as a failure (e.g. the broadcast propagated but the HTTP response
        // never came back). Retrying would build a doomed double-spend, and the ensuing
        // "permanent" failure would trigger a refund of money that is no longer there.
        const spent = await chainProviders.isOutputSpent(request.paymentTxId, 0, config);
        if (spent.ok && spent.spent) {
            console.warn(
                `[Reconcile] NOT retrying ${request.id}: its payment output is already spent by ${spent.spentBy}. ` +
                `An earlier attempt likely succeeded — needs manual confirmation.`
            );
            await dbRun(
                db,
                `UPDATE requests SET failureReason = ?
                 WHERE id = ? AND opReturnTxId IS NULL AND refundTxId IS NULL`,
                [`inputs_already_spent: payment output spent by ${spent.spentBy} — verify on-chain before refunding`, request.id]
            );
            continue;
        }

        // Move back into the state fulfillRequest can lock, conditionally so a
        // concurrent worker cannot pick up the same request.
        const claim = await dbRun(
            db,
            `UPDATE requests SET status = 'payment_confirmed'
             WHERE id = ? AND status = 'op_return_failed' AND opReturnTxId IS NULL AND refundTxId IS NULL`,
            [request.id]
        );
        if (claim.changes === 0) continue;

        console.log(`[Reconcile] Retrying request ${request.id} (attempt ${(request.attemptCount || 0) + 1}/${maxAttempts})`);
        const result = await fulfillRequest({ ...request, status: 'payment_confirmed' }, db, rootNode, config);
        retried++;
        if (result.success) {
            console.log(`[Reconcile] Retry succeeded for ${request.id}: ${result.opReturnTxId}`);
        }
    }
    return retried;
}

async function refundStrandedRequests(db, rootNode, config) {
    const maxAttempts = config.MAX_FULFILL_ATTEMPTS || 3;

    // Terminally failed: either the reason can never succeed, or attempts are spent.
    const candidates = await dbAll(
        db,
        `SELECT * FROM requests
         WHERE status IN ('op_return_failed', 'refund_failed')
           AND opReturnTxId IS NULL
           AND refundTxId IS NULL
           AND refundAddress IS NOT NULL
           AND paymentTxId IS NOT NULL`,
        []
    );

    let refunded = 0;
    for (const request of candidates) {
        const exhausted = (request.attemptCount || 0) >= maxAttempts;
        if (!exhausted && !isPermanentReason(request.failureReason)) {
            continue; // still retryable; leave it to the retry pass
        }
        // Never auto-refund when the payment UTXO is already gone: there is nothing to
        // return, and an earlier attempt may in fact have succeeded.
        if (isNoRefundReason(request.failureReason)) {
            continue;
        }
        // Don't hammer a refund that already failed for a structural reason that a
        // repeat attempt cannot change. Checked against refundFailureReason, which is
        // where the refund path records its own errors.
        if (request.status === 'refund_failed'
            && /below_dust|no_refund_address|invalid_refund_address|no_confirmed_funds/.test(request.refundFailureReason || '')) {
            continue;
        }

        const result = await attemptRefund(request, db, rootNode, config);
        if (result.ok) {
            refunded++;
            console.log(`[Reconcile] Refunded ${request.id}: ${result.refundTxId} (${result.amount} sats)`);
        }
    }
    return refunded;
}

/**
 * Anything that took money and delivered neither an OP_RETURN nor a refund.
 * Logged loudly every pass so it cannot go unnoticed.
 */
async function reportStrandedFunds(db) {
    const stranded = await dbAll(
        db,
        `SELECT id, address, status, failureReason, paymentReceivedSatoshis, refundAddress, createdAt
         FROM requests
         WHERE paymentTxId IS NOT NULL
           AND opReturnTxId IS NULL
           AND refundTxId IS NULL`,
        []
    );

    if (stranded.length === 0) return [];

    console.warn(`[Reconcile] *** ${stranded.length} request(s) hold customer funds with nothing delivered ***`);
    for (const r of stranded) {
        console.warn(
            `[Reconcile]   ${r.id} status=${r.status} received=${r.paymentReceivedSatoshis ?? 'unknown'} ` +
            `address=${r.address} refundTo=${r.refundAddress || 'UNKNOWN'} reason=${r.failureReason || 'n/a'}`
        );
    }
    return stranded;
}

// A pass makes real Bitcoin transactions. If one runs long, the interval timer must not
// start a second pass alongside it.
let passInFlight = false;

async function runReconciliation(db, rootNode, config) {
    if (passInFlight) {
        console.log('[Reconcile] Previous pass still running — skipping this tick.');
        return { skipped: true };
    }
    passInFlight = true;

    console.log('[Reconcile] Starting reconciliation pass...');
    try {
        const unstuck = await unstickAbandonedLocks(db);
        const driven = await drivePaidRequests(db, rootNode, config);
        const retried = await retryFailedRequests(db, rootNode, config);
        const refunded = await refundStrandedRequests(db, rootNode, config);
        const stranded = await reportStrandedFunds(db);

        console.log(
            `[Reconcile] Pass complete. Unstuck: ${unstuck}, driven: ${driven}, retried: ${retried}, ` +
            `refunded: ${refunded}, still stranded: ${stranded.length}`
        );
        return { unstuck, driven, retried, refunded, stranded: stranded.length };
    } catch (error) {
        console.error('[Reconcile] Reconciliation pass failed:', error);
        return { error: error.message };
    } finally {
        passInFlight = false;
    }
}

module.exports = { runReconciliation, reportStrandedFunds, isPermanentReason, isNoRefundReason };
