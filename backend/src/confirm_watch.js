// backend/src/confirm_watch.js
//
// Notices when a published OP_RETURN transaction reaches a block.
//
// Until this existed, nothing in the service ever looked at a transaction again once it
// was broadcast. Every reconcile pass filters `opReturnTxId IS NULL`, and alerts.js only
// ever asks about rows where it is null — so an OP_RETURN that broadcast at the relay
// floor and was then evicted from the mempool was invisible: the customer's money taken,
// the order marked delivered, and nothing anywhere to say it never landed. The default
// fee rate is 2 sat/vB, which is exactly the tier where that happens.
//
// THREE RULES.
//
//   1. This is a VIEW path, so it may not spend the BlockCypher allowance the webhooks and
//      broadcasts depend on. chain_providers.getTxStatus is Esplora-only and there is no
//      BlockCypher implementation of the method at all, so the restriction holds
//      structurally rather than by convention.
//
//   2. A read that FAILED is not a read that said "unconfirmed". On any error the row is
//      left exactly as it was and retried next pass. Recording a negative because a host
//      timed out would paint a healthy order as stuck — the same mistake as showing an
//      unreadable balance as zero.
//
//   3. Bounded per pass. `requests` grows forever and rows are never deleted, so an
//      unbounded sweep would fire the whole back catalogue at blockstream.info on every
//      boot. Oldest-unconfirmed first, capped, and already-confirmed rows are never
//      re-read — the write is one-way.

const { dbAll, dbRun } = require('./db_utils');
const chainProviders = require('./chain_providers');

/** Most transactions checked in one pass. */
const MAX_PER_PASS = 25;

/**
 * How long after broadcast we keep asking. A transaction at 2 sat/vB can legitimately
 * take days, so this is generous; past it the operator alert is the right surface, not
 * an endless poll.
 */
const GIVE_UP_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Checks a bounded batch of broadcast-but-unconfirmed transactions.
 *
 * @returns {Promise<{checked: number, confirmed: number, failed: number}>}
 */
async function checkPendingConfirmations(db, config) {
    let candidates;
    try {
        candidates = await dbAll(
            db,
            `SELECT id, opReturnTxId, COALESCE(lastAttemptAt, paymentConfirmedAt, createdAt) AS broadcastAt
               FROM requests
              WHERE opReturnTxId IS NOT NULL
                AND opReturnConfirmedAt IS NULL
                AND COALESCE(lastAttemptAt, paymentConfirmedAt, createdAt) > ?
              ORDER BY COALESCE(lastAttemptAt, paymentConfirmedAt, createdAt) ASC
              LIMIT ?`,
            [new Date(Date.now() - GIVE_UP_AFTER_MS).toISOString(), MAX_PER_PASS]
        );
    } catch (error) {
        console.warn(`[ConfirmWatch] Could not list candidates: ${error.message}`);
        return { checked: 0, confirmed: 0, failed: 0 };
    }

    if (candidates.length === 0) return { checked: 0, confirmed: 0, failed: 0 };

    let confirmed = 0;
    let failed = 0;

    for (const row of candidates) {
        const status = await chainProviders.getTxStatus(row.opReturnTxId, config);

        // Rule 2: an unreadable answer changes nothing.
        if (!status.ok) {
            failed++;
            continue;
        }
        if (!status.confirmed) continue;

        try {
            // Guarded so a concurrent pass cannot write it twice, and so the txid we
            // asked about is still the txid on the row.
            const write = await dbRun(
                db,
                `UPDATE requests
                    SET opReturnConfirmedAt = ?, opReturnBlockHeight = ?
                  WHERE id = ? AND opReturnTxId = ? AND opReturnConfirmedAt IS NULL`,
                [new Date().toISOString(), status.blockHeight, row.id, row.opReturnTxId]
            );
            if (write.changes > 0) {
                confirmed++;
                console.log(`[ConfirmWatch] ${row.id} mined in block ${status.blockHeight ?? '?'}.`);
            }
        } catch (error) {
            console.warn(`[ConfirmWatch] Could not record confirmation for ${row.id}: ${error.message}`);
            failed++;
        }
    }

    if (confirmed > 0 || failed > 0) {
        console.log(`[ConfirmWatch] Pass complete. Checked: ${candidates.length}, confirmed: ${confirmed}, unreadable: ${failed}.`);
    }
    return { checked: candidates.length, confirmed, failed };
}

module.exports = { checkPendingConfirmations, MAX_PER_PASS, GIVE_UP_AFTER_MS };
