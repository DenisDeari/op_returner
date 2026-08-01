// backend/src/alerts.js
//
// Computes the current list of things that need a human, straight from the database.
//
// Deliberately derived from stored state rather than from log lines: a restart wipes
// logs, and the failure this whole change set exists to prevent went unnoticed for 66
// days precisely because nothing surfaced it. An alert here persists until the
// underlying row is actually resolved.

const { dbAll } = require('./db_utils');

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
