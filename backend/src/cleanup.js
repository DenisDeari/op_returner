const webhookManager = require('./webhook_manager');
const config = require('./config');
const chainProviders = require('./chain_providers');
const notifier = require('./notifier');
const { dbAll, dbRun } = require('./db_utils');
const events = require('./request_events');

// Never verify more than this many addresses per pass, to stay within provider rate limits.
const MAX_CHAIN_CHECKS_PER_PASS = 25;

// Columns that mean "this row has touched money". Every write below carries all four, so
// a payment landing mid-pass can never be raced into a retirement or an archive.
const UNTOUCHED_BY_MONEY = `
    paymentTxId IS NULL
    AND paymentReceivedSatoshis IS NULL
    AND opReturnTxId IS NULL
    AND refundTxId IS NULL`;

/**
 * Retires the BlockCypher webhooks of orders nobody has paid.
 *
 * Separate from archiving, and earlier, because the two deadlines answer different
 * questions. Holding two hooks open per abandoned order spends a free-tier allowance the
 * payment path depends on, so watching stops at WEBHOOK_RETIRE_AFTER_MS. Whether the row
 * survives is decided later, at REQUEST_ARCHIVE_AFTER_MS, after a final chain check.
 *
 * The row is claimed first and the hooks torn down second. deleteWebhook cannot report
 * success — every path returns undefined — so the claim is the only durable record that
 * this was attempted, and it carries the money guards so a payment arriving mid-pass
 * stops the retirement rather than being silently unwatched.
 */
async function retireStaleWebhooks(db) {
    const cutoff = new Date(Date.now() - config.WEBHOOK_RETIRE_AFTER_MS).toISOString();

    const candidates = await dbAll(
        db,
        `SELECT id, address, blockcypherHookId FROM requests
         WHERE status = 'pending_payment'
           AND createdAt < ?
           AND archivedAt IS NULL
           AND webhooksRetiredAt IS NULL
           AND blockcypherHookId IS NOT NULL
           AND ${UNTOUCHED_BY_MONEY}
         ORDER BY createdAt ASC`,
        [cutoff]
    );

    if (candidates.length === 0) return 0;

    let retired = 0;
    for (const row of candidates) {
        const claim = await dbRun(
            db,
            `UPDATE requests SET webhooksRetiredAt = ?
             WHERE id = ?
               AND webhooksRetiredAt IS NULL
               AND archivedAt IS NULL
               AND ${UNTOUCHED_BY_MONEY}`,
            [new Date().toISOString(), row.id]
        );
        if (claim.changes !== 1) continue; // paid or handled since the SELECT

        // blockcypherHookId holds a comma-joined pair; deleteWebhook splits it itself.
        webhookManager.deleteWebhook(row.blockcypherHookId, config);
        events.record(db, row.id, events.KINDS.WEBHOOKS_RETIRED, `unpaid after ${config.WEBHOOK_RETIRE_AFTER_MS / 3600000}h`);
        retired++;
        console.log(`[Cleanup] Retired webhooks for unpaid request ${row.id} (${row.address}).`);
    }

    if (retired > 0) {
        console.log(`[Cleanup] Stopped watching ${retired} unpaid address(es) older than ${config.WEBHOOK_RETIRE_AFTER_MS / 3600000}h.`);
    }
    return retired;
}

/**
 * Records a payment found at an address we were about to archive, and reports it.
 *
 * Deliberately does NOT archive the row, and deliberately does not fulfil or refund it
 * either. The order was abandoned days ago and money turned up anyway; that is a decision
 * for a human, not for a timer.
 *
 * Writing paymentReceivedSatoshis and refundAddress is what makes the human's options
 * exist at all: the admin panel only renders its Refund button when a row carries a
 * payment (frontend/admin/admin.js), and refund.js refuses outright when refundAddress is
 * null. Recording paymentTxId additionally makes the row match the two queries that key
 * on payment alone — alerts.js and reconcile's stranded report — so it stays loudly
 * visible until someone deals with it.
 */
async function recordUnexpectedPayment(db, row, stats) {
    let paymentTxId = null;
    let refundAddress = null;
    let value = stats.totalReceived;

    const unspent = await chainProviders.getUnspent(row.address, config);
    if (unspent.ok && unspent.utxos.length > 0) {
        const utxo = unspent.utxos[0];
        paymentTxId = utxo.txId;
        value = unspent.utxos.reduce((sum, u) => sum + u.value, 0);
        const payer = await chainProviders.getPayerAddress(utxo.txId, config);
        if (payer.ok) refundAddress = payer.address;
    }

    // failureReason IS NULL is the once-only guard: this pass runs every six hours and
    // must not re-report the same row forever.
    const claim = await dbRun(
        db,
        `UPDATE requests
         SET paymentReceivedSatoshis = ?,
             paymentTxId = COALESCE(paymentTxId, ?),
             refundAddress = COALESCE(refundAddress, ?),
             failureReason = ?
         WHERE id = ? AND failureReason IS NULL AND archivedAt IS NULL`,
        [
            value, paymentTxId, refundAddress,
            `unexpected payment found at archive time: ${value} sats at ${row.address}`,
            row.id,
        ]
    );

    if (claim.changes !== 1) return false;

    console.warn(
        `[Cleanup] KEEPING ${row.id}: ${row.address} holds ${value} sats but the request was never marked paid. ` +
        `Not archived. Refund address ${refundAddress || 'UNKNOWN'}.`
    );
    events.record(db, row.id, events.KINDS.UNEXPECTED_PAYMENT, `${value} sats at ${row.address}, refund to ${refundAddress || 'UNKNOWN'}`);
    notifier.notifyArchiveFunded({
        requestId: row.id,
        address: row.address,
        amount: value,
        refundAddress,
        createdAt: row.createdAt,
    }, config);
    return true;
}

/**
 * Archives old, abandoned requests instead of deleting them.
 *
 * Rows are never removed. A row is the only record of what a customer asked for and which
 * address they were quoted, and destroying it makes a late payment unattributable — the
 * wallet view could see money at a derived address with nothing to explain it.
 *
 * SAFETY: a request is only ever archived once we are confident no money reached it.
 * Two independent guards, unchanged from when this job deleted rows:
 *   1. Database — skip anything with a recorded payment.
 *   2. Blockchain — ask a provider whether the address ever received funds. If the
 *      lookup fails we keep the row; an unverified row is never archived.
 * An address that turns out to hold money is recorded and reported instead.
 */
async function archiveAbandonedRequests(db) {
    const cutoff = new Date(Date.now() - config.REQUEST_ARCHIVE_AFTER_MS).toISOString();

    console.log(`[Cleanup] Looking for abandoned requests older than ${cutoff}...`);

    // archivedAt IS NULL matters more than it looks: without it, every row ever archived
    // would be re-selected on every pass and consume the whole chain-check budget, so
    // genuinely new candidates would silently stop being checked. ORDER BY createdAt ASC
    // for the same reason — there is no index on status or createdAt, so this is a table
    // scan returning insertion order.
    const candidates = await dbAll(
        db,
        `SELECT id, address, blockcypherHookId, createdAt, webhooksRetiredAt FROM requests
         WHERE status = 'pending_payment'
           AND createdAt < ?
           AND archivedAt IS NULL
           AND ${UNTOUCHED_BY_MONEY}
         ORDER BY createdAt ASC`,
        [cutoff]
    );

    if (candidates.length === 0) {
        console.log('[Cleanup] No abandoned requests to archive.');
        return { archived: 0, funded: 0, kept: 0 };
    }

    console.log(`[Cleanup] ${candidates.length} candidate(s). Verifying against the blockchain before archiving.`);

    let archived = 0, funded = 0, kept = 0, checked = 0;

    for (const row of candidates) {
        if (checked >= MAX_CHAIN_CHECKS_PER_PASS) {
            kept++;
            console.log(`[Cleanup]   ${row.id} — not verified this pass (rate limit)`);
            continue;
        }
        checked++;

        // Guard 2 (blockchain). Esplora only: this runs on a timer over many addresses and
        // BlockCypher bills each one against the allowance the money paths depend on.
        const stats = await chainProviders.getAddressStats(row.address, config, {
            onlyProviders: chainProviders.ESPLORA_ONLY,
            useCooldown: true,
        });
        if (!stats.ok) {
            kept++;
            console.log(`[Cleanup]   ${row.id} — chain lookup failed: ${stats.reason}`);
            continue;
        }

        if (stats.totalReceived > 0) {
            if (await recordUnexpectedPayment(db, row, stats)) funded++;
            else kept++;
            continue;
        }

        // Claim the row FIRST, then stop watching it. The old code tore the webhooks down
        // before the guarded write, so a payment landing mid-pass left a funded row whose
        // hooks were already gone and nothing recording that.
        const claim = await dbRun(
            db,
            `UPDATE requests
             SET archivedAt = ?, archivedReason = 'abandoned_unpaid'
             WHERE id = ?
               AND status = 'pending_payment'
               AND archivedAt IS NULL
               AND ${UNTOUCHED_BY_MONEY}`,
            [new Date().toISOString(), row.id]
        );
        if (claim.changes !== 1) {
            kept++;
            console.log(`[Cleanup]   ${row.id} — changed under us mid-pass, left alone`);
            continue;
        }

        if (row.blockcypherHookId && !row.webhooksRetiredAt) {
            webhookManager.deleteWebhook(row.blockcypherHookId, config);
            await dbRun(db, 'UPDATE requests SET webhooksRetiredAt = ? WHERE id = ? AND webhooksRetiredAt IS NULL',
                [new Date().toISOString(), row.id]);
        }
        events.record(db, row.id, events.KINDS.ARCHIVED, 'abandoned_unpaid: never funded, verified against the chain');
        archived++;
        console.log(`[Cleanup] Archived ${row.id} (${row.address}) — abandoned, never funded.`);
    }

    console.log(`[Cleanup] Pass complete. Archived: ${archived}, funded-and-kept: ${funded}, kept: ${kept}.`);
    return { archived, funded, kept };
}

/**
 * The scheduled retention job. Retires webhooks first so an address stops costing quota
 * as early as possible, then decides which rows are finished with.
 */
async function cleanupOldRequests(db) {
    try {
        await retireStaleWebhooks(db);
        await archiveAbandonedRequests(db);
    } catch (error) {
        console.error('[Cleanup] Error during cleanup:', error.message);
    }
}

module.exports = { cleanupOldRequests, retireStaleWebhooks, archiveAbandonedRequests };
