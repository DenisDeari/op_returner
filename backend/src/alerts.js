// backend/src/alerts.js
//
// Computes the current list of things that need a human, straight from the database.
//
// Deliberately derived from stored state rather than from log lines: a restart wipes
// logs, and the failure this whole change set exists to prevent went unnoticed for 66
// days precisely because nothing surfaced it. An alert here persists until the
// underlying row is actually resolved.

const { dbAll } = require('./db_utils');
const confirmWatch = require('./confirm_watch');

// How long a request may sit mid-fulfilment or mid-refund before it counts as stuck.
const STUCK_AFTER_MS = 30 * 60 * 1000;

function sats(n) {
    return n === null || n === undefined ? 'unknown' : `${n} sats`;
}

/**
 * @returns {Promise<{alerts: object[], counts: object}>} highest severity first
 */
async function computeAlerts(db, config = {}) {
    const alerts = [];
    const maxAttempts = config.MAX_FULFILL_ATTEMPTS || 3;
    const stuckCutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();

    // --- The one that actually matters: money in, nothing out ------------
    const stranded = await dbAll(
        db,
        `SELECT id, address, status, failureReason, refundFailureReason,
                paymentReceivedSatoshis, requiredAmountSatoshis, refundAddress,
                attemptCount, createdAt
         FROM requests
         WHERE paymentTxId IS NOT NULL
           AND opReturnTxId IS NULL
           AND refundTxId IS NULL
         ORDER BY createdAt ASC`
    );

    for (const r of stranded) {
        const underpaid = r.paymentReceivedSatoshis != null
            && r.paymentReceivedSatoshis < r.requiredAmountSatoshis;
        const exhausted = (r.attemptCount || 0) >= maxAttempts;

        let detail;
        if (underpaid) {
            detail = `Customer underpaid: sent ${sats(r.paymentReceivedSatoshis)} of ${sats(r.requiredAmountSatoshis)} required. `
                + `Their money is held. Either they top it up, or you refund them.`;
        } else if (r.status === 'refund_failed') {
            detail = `Delivery failed AND the refund failed. Reason: ${r.refundFailureReason || 'unknown'}. Needs manual handling.`;
        } else if (exhausted) {
            detail = `Delivery failed ${r.attemptCount} times and will not be retried automatically. `
                + `Reason: ${r.failureReason || 'unknown'}.`;
        } else {
            detail = `Paid but not yet delivered. Reason: ${r.failureReason || 'awaiting processing'}. `
                + `Automatic retry is still in progress (${r.attemptCount || 0}/${maxAttempts}).`;
        }

        if (!r.refundAddress) {
            detail += ' No refund address on record, so it cannot be refunded automatically.';
        }

        alerts.push({
            severity: (exhausted || r.status === 'refund_failed' || underpaid) ? 'critical' : 'warning',
            kind: underpaid ? 'underpaid' : 'funds_held',
            requestId: r.id,
            title: underpaid
                ? `Underpaid order holding ${sats(r.paymentReceivedSatoshis)}`
                : `Order holding ${sats(r.paymentReceivedSatoshis)} with nothing delivered`,
            detail,
            address: r.address,
            since: r.createdAt,
        });
    }

    // --- Stuck mid-operation ---------------------------------------------
    const stuck = await dbAll(
        db,
        `SELECT id, status, lastAttemptAt, createdAt FROM requests
         WHERE status IN ('processing_op_return', 'refund_processing')
           AND opReturnTxId IS NULL AND refundTxId IS NULL
           AND COALESCE(lastAttemptAt, createdAt) < ?`,
        [stuckCutoff]
    );
    for (const r of stuck) {
        alerts.push({
            severity: 'warning',
            kind: 'stuck',
            requestId: r.id,
            title: `Order stuck in "${r.status.replace(/_/g, ' ')}" for over 30 minutes`,
            detail: 'Probably interrupted by a restart. The reconciliation job should release it on its next pass.',
            since: r.lastAttemptAt || r.createdAt,
        });
    }

    // --- Broadcast, but never mined --------------------------------------
    //
    // The one failure mode this service had no detector for. Every reconcile pass filters
    // `opReturnTxId IS NULL`, so once a transaction is broadcast nothing ever looks at it
    // again — and the default fee rate is the 2 sat/vB relay floor, which is exactly the
    // tier that gets evicted from the mempool when it fills. The customer's money was
    // taken, the order reads delivered, and the message is nowhere. confirm_watch.js
    // supplies opReturnConfirmedAt; this turns its absence into something visible.
    // Bounded at BOTH ends, and the older bound matters as much as the newer one. The
    // watcher stops asking after confirm_watch.GIVE_UP_AFTER_MS, so anything older than
    // that is not "unconfirmed" — it is unchecked, and alerting on it would be a warning
    // nobody can act on and nothing can ever clear. Alerts have to stay clearable or the
    // panel becomes noise the operator learns to skip past.
    const unconfirmedCutoff = new Date(Date.now() - (config.OP_RETURN_UNCONFIRMED_ALERT_MS || 24 * 60 * 60 * 1000)).toISOString();
    const stillWatchedSince = new Date(Date.now() - confirmWatch.GIVE_UP_AFTER_MS).toISOString();
    const unmined = await dbAll(
        db,
        `SELECT id, opReturnTxId, feeRate, COALESCE(lastAttemptAt, paymentConfirmedAt, createdAt) AS broadcastAt
           FROM requests
          WHERE opReturnTxId IS NOT NULL
            AND opReturnConfirmedAt IS NULL
            AND COALESCE(lastAttemptAt, paymentConfirmedAt, createdAt) < ?
            AND COALESCE(lastAttemptAt, paymentConfirmedAt, createdAt) > ?
          ORDER BY broadcastAt ASC`,
        [unconfirmedCutoff, stillWatchedSince]
    );
    for (const r of unmined) {
        const hours = Math.floor((Date.now() - new Date(r.broadcastAt).getTime()) / 3600000);
        alerts.push({
            severity: 'warning',
            kind: 'unconfirmed_op_return',
            requestId: r.id,
            title: `Published ${hours}h ago but still not in a block`,
            detail: `Broadcast at ${r.feeRate || '?'} sat/vB and not mined since. It may simply be slow, or it may have been `
                + `dropped from the mempool — in which case the customer paid and the message is not on-chain. `
                + `Check ${r.opReturnTxId}.`,
            since: r.broadcastAt,
        });
    }

    // --- Customers who wrote to you --------------------------------------
    const feedback = await dbAll(
        db,
        `SELECT id, userFeedback, userFeedbackAt FROM requests
         WHERE userFeedback IS NOT NULL
         ORDER BY userFeedbackAt DESC LIMIT 20`
    );
    for (const r of feedback) {
        alerts.push({
            severity: 'info',
            kind: 'customer_message',
            requestId: r.id,
            title: 'A customer left a message about a failed order',
            detail: r.userFeedback,
            since: r.userFeedbackAt,
        });
    }

    const order = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => order[a.severity] - order[b.severity] || String(a.since).localeCompare(String(b.since)));

    const counts = {
        critical: alerts.filter((a) => a.severity === 'critical').length,
        warning: alerts.filter((a) => a.severity === 'warning').length,
        info: alerts.filter((a) => a.severity === 'info').length,
        total: alerts.length,
    };

    return { alerts, counts };
}

module.exports = { computeAlerts, STUCK_AFTER_MS };
