const webhookManager = require('./webhook_manager');
const config = require('./config');
const chainProviders = require('./chain_providers');
const { dbAll, dbRun } = require('./db_utils');

// Never verify more than this many addresses per pass, to stay within provider rate limits.
const MAX_CHAIN_CHECKS_PER_PASS = 25;

/**
 * Deletes old, abandoned requests from the database to keep it clean.
 *
 * SAFETY: a request is only ever deleted once we are confident no money was sent to it.
 * Deleting a funded request would destroy the only record of what the customer paid for
 * (their message, their refund address), so this errs heavily toward keeping rows.
 *
 * Two independent guards:
 *   1. Database — skip anything with a recorded payment.
 *   2. Blockchain — ask a provider whether the address ever received funds. If the
 *      lookup fails we keep the row; an unverified row is never deleted.
 *
 * @param {object} db - The SQLite database connection object.
 */
async function cleanupOldRequests(db) {
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    console.log(`[Cleanup] Running job to delete pending requests older than ${fortyEightHoursAgo}...`);

    try {
        // Guard 1 (database): never consider a request that has any sign of payment.
        const candidates = await dbAll(
            db,
            `SELECT id, address, blockcypherHookId FROM requests
             WHERE status = 'pending_payment'
               AND createdAt < ?
               AND paymentTxId IS NULL
               AND paymentReceivedSatoshis IS NULL
               AND opReturnTxId IS NULL
               AND refundTxId IS NULL`,
            [fortyEightHoursAgo]
        );

        if (candidates.length === 0) {
            console.log('[Cleanup] No old, pending requests to delete.');
            return;
        }

        console.log(`[Cleanup] ${candidates.length} candidate(s) found. Verifying against the blockchain before deleting.`);

        const deletable = [];
        const kept = [];
        let checked = 0;

        for (const candidate of candidates) {
            if (checked >= MAX_CHAIN_CHECKS_PER_PASS) {
                kept.push({ id: candidate.id, reason: 'not verified this pass (rate limit)' });
                continue;
            }
            checked++;

            // Guard 2 (blockchain): has this address ever received anything?
            //
            // Esplora only. This runs on a timer over up to MAX_CHAIN_CHECKS_PER_PASS
            // addresses, and BlockCypher bills each one against the free-tier allowance
            // the webhooks and broadcasts depend on. If both hosts fail the lookup fails,
            // and an unverified row is kept — so restricting providers can only ever make
            // this job more cautious, never less.
            const stats = await chainProviders.getAddressStats(candidate.address, config, {
                onlyProviders: chainProviders.ESPLORA_ONLY,
                useCooldown: true,
            });
            if (!stats.ok) {
                // Could not verify — keep it. An unverified row is never deleted.
                kept.push({ id: candidate.id, reason: `chain lookup failed: ${stats.reason}` });
                continue;
            }
            if (stats.totalReceived > 0) {
                console.warn(
                    `[Cleanup] KEEPING ${candidate.id}: address ${candidate.address} received ${stats.totalReceived} sats ` +
                    `but the request is still marked pending_payment. Flagging for reconciliation.`
                );
                await dbRun(
                    db,
                    "UPDATE requests SET failureReason = ? WHERE id = ? AND failureReason IS NULL",
                    [`unrecorded payment detected by cleanup: ${stats.totalReceived} sats at ${candidate.address}`, candidate.id]
                );
                kept.push({ id: candidate.id, reason: `funded with ${stats.totalReceived} sats` });
                continue;
            }

            deletable.push(candidate);
        }

        if (kept.length > 0) {
            console.log(`[Cleanup] Kept ${kept.length} request(s) that could not be safely deleted:`);
            for (const k of kept) {
                console.log(`[Cleanup]   ${k.id} — ${k.reason}`);
            }
        }

        if (deletable.length === 0) {
            console.log('[Cleanup] Nothing safe to delete this pass.');
            return;
        }

        for (const row of deletable) {
            if (row.blockcypherHookId) {
                webhookManager.deleteWebhook(row.blockcypherHookId, config);
            }
        }

        // Delete by explicit id list, re-checking the payment guards at delete time so a
        // payment arriving mid-pass cannot be raced away.
        const placeholders = deletable.map(() => '?').join(',');
        const result = await dbRun(
            db,
            `DELETE FROM requests
             WHERE id IN (${placeholders})
               AND status = 'pending_payment'
               AND paymentTxId IS NULL
               AND paymentReceivedSatoshis IS NULL`,
            deletable.map((r) => r.id)
        );

        console.log(`[Cleanup] Successfully deleted ${result.changes} old, unfunded, pending requests.`);
    } catch (error) {
        console.error('[Cleanup] Error during cleanup:', error.message);
    }
}

module.exports = { cleanupOldRequests };
