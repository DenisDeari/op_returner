const webhookManager = require('./webhook_manager');
const webhookReconcile = require('./webhook_reconcile');
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

    // No early return when this is empty: the settled sweep below is independent of it.
    let retired = 0;
    for (const row of candidates) {
        const stamp = new Date().toISOString();
        const claim = await dbRun(
            db,
            `UPDATE requests SET webhooksRetiredAt = ?
             WHERE id = ?
               AND webhooksRetiredAt IS NULL
               AND archivedAt IS NULL
               AND ${UNTOUCHED_BY_MONEY}`,
            [stamp, row.id]
        );
        if (claim.changes !== 1) continue; // paid or handled since the SELECT

        // blockcypherHookId holds a comma-joined pair; deleteWebhookIds splits it itself.
        const torn = await webhookManager.deleteWebhookIds(row.blockcypherHookId, config);
        if (!torn.ok) {
            // The stamp is a claim, not a fact, and this is the moment that distinction
            // costs money. BlockCypher refuses deletes in bursts — precisely when a batch
            // of stale orders is being cleaned up — and a stamp left in place would record
            // a teardown that never happened, taking the row out of every future pass while
            // its hooks stay live forever. Hand it back instead; the next pass retries.
            await dbRun(
                db,
                'UPDATE requests SET webhooksRetiredAt = NULL WHERE id = ? AND webhooksRetiredAt = ?',
                [row.id, stamp]
            );
            console.warn(`[Cleanup] Could not retire webhooks for ${row.id}: ${torn.reasons.join('; ')}. Will retry.`);
            continue;
        }

        events.record(db, row.id, events.KINDS.WEBHOOKS_RETIRED, `unpaid after ${config.WEBHOOK_RETIRE_AFTER_MS / 3600000}h`);
        retired++;
        console.log(`[Cleanup] Retired webhooks for unpaid request ${row.id} (${row.address}).`);
    }

    // Settled orders, at any age. A request that has been published or refunded is
    // finished, and nothing will ever notify us about it again — but the deleteWebhook
    // fired at fulfilment and refund time is unawaited and cannot report success, so
    // whether those hooks are really gone has always been unknowable. Nine rows in
    // production carry a hook id that was never marked retired; without this they would
    // stay that way forever, quietly holding a quota the payment path depends on.
    // Deleting twice is harmless: BlockCypher answers 404 and deleteWebhook swallows it.
    const settled = await dbAll(
        db,
        `SELECT id, address, blockcypherHookId FROM requests
         WHERE blockcypherHookId IS NOT NULL
           AND webhooksRetiredAt IS NULL
           AND (opReturnTxId IS NOT NULL OR refundTxId IS NOT NULL)
         ORDER BY createdAt ASC`
    );

    for (const row of settled) {
        const stamp = new Date().toISOString();
        const claim = await dbRun(
            db,
            `UPDATE requests SET webhooksRetiredAt = ?
             WHERE id = ?
               AND webhooksRetiredAt IS NULL
               AND (opReturnTxId IS NOT NULL OR refundTxId IS NOT NULL)`,
            [stamp, row.id]
        );
        if (claim.changes !== 1) continue;

        const torn = await webhookManager.deleteWebhookIds(row.blockcypherHookId, config);
        if (!torn.ok) {
            await dbRun(
                db,
                'UPDATE requests SET webhooksRetiredAt = NULL WHERE id = ? AND webhooksRetiredAt = ?',
                [row.id, stamp]
            );
            console.warn(`[Cleanup] Could not retire webhooks for settled ${row.id}: ${torn.reasons.join('; ')}. Will retry.`);
            continue;
        }

        events.record(db, row.id, events.KINDS.WEBHOOKS_RETIRED, 'order settled');
        retired++;
        console.log(`[Cleanup] Retired webhooks for settled request ${row.id}.`);
    }

    if (retired > 0) {
        console.log(`[Cleanup] Stopped watching ${retired} address(es).`);
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
         WHERE id = ? AND failureReason IS NULL`,
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

        // Stamped only if the hooks are confirmed gone. The archive itself stands either
        // way — the row is finished with — but claiming a teardown we did not achieve
        // would hide a live hook from every pass that follows. Left unstamped, the row is
        // archived and its hooks are picked up by the orphan sweep instead.
        if (row.blockcypherHookId && !row.webhooksRetiredAt) {
            const torn = await webhookManager.deleteWebhookIds(row.blockcypherHookId, config);
            if (torn.ok) {
                await dbRun(db, 'UPDATE requests SET webhooksRetiredAt = ? WHERE id = ? AND webhooksRetiredAt IS NULL',
                    [new Date().toISOString(), row.id]);
            } else {
                console.warn(`[Cleanup] Archived ${row.id} but could not delete its webhooks: ${torn.reasons.join('; ')}.`);
            }
        }
        events.record(db, row.id, events.KINDS.ARCHIVED, 'abandoned_unpaid: never funded, verified against the chain');
        archived++;
        console.log(`[Cleanup] Archived ${row.id} (${row.address}) — abandoned, never funded.`);
    }

    console.log(`[Cleanup] Pass complete. Archived: ${archived}, funded-and-kept: ${funded}, kept: ${kept}.`);
    return { archived, funded, kept };
}

/**
 * Drops the content of archived orders that were never paid, long after the fact.
 *
 * The ROW IS NOT DELETED. It keeps the index, the address and the derivation path, so a
 * payment arriving years later is still attributable to a specific order, the wallet view
 * can still explain money at a derived address, and the UNIQUE constraints still stop an
 * index being re-issued. Only the parts that are a stranger's words go: the message, any
 * feedback they wrote, and the address they asked us to pay.
 *
 * Everything a behavioural question needs survives — when it was made, what fee rate,
 * what amount, how it died, and (via messageBytes) how long the message was.
 *
 * The event log is redacted alongside it. `detail` on a feedback event holds the text
 * verbatim, and on a created event it holds the recipient address; redacting `requests`
 * alone would leave both behind. Kind and timestamp are kept, so the shape of what
 * happened survives without the content.
 *
 * This is the one irreversible operation in the service, so it is guarded like an
 * archive and then some: only archived rows, only ones with no sign of money, only past
 * REDACT_ARCHIVED_AFTER_MS, and only after a fresh chain check. Money can arrive at an
 * abandoned address at any time, and if it has, the message is the only record of what
 * that money was for — so a funded address is reported and left completely alone.
 */
async function redactOldArchivedRequests(db) {
    if (!config.REDACTION_ENABLED) return { redacted: 0, funded: 0, kept: 0 };

    const cutoff = new Date(Date.now() - config.REDACT_ARCHIVED_AFTER_MS).toISOString();

    const candidates = await dbAll(
        db,
        `SELECT id, address, message, createdAt FROM requests
         WHERE archivedAt IS NOT NULL
           AND archivedAt < ?
           AND redactedAt IS NULL
           AND ${UNTOUCHED_BY_MONEY}
         ORDER BY archivedAt ASC`,
        [cutoff]
    );

    if (candidates.length === 0) return { redacted: 0, funded: 0, kept: 0 };

    console.log(`[Cleanup] ${candidates.length} archived request(s) past the ${config.REDACT_ARCHIVED_AFTER_MS / 86400000}-day content horizon.`);

    let redacted = 0, funded = 0, kept = 0, checked = 0;

    for (const row of candidates) {
        if (checked >= MAX_CHAIN_CHECKS_PER_PASS) { kept++; continue; }
        checked++;

        const stats = await chainProviders.getAddressStats(row.address, config, {
            onlyProviders: chainProviders.ESPLORA_ONLY,
            useCooldown: true,
        });
        if (!stats.ok) {
            kept++;
            console.log(`[Cleanup]   ${row.id} — not redacted, chain lookup failed: ${stats.reason}`);
            continue;
        }
        if (stats.totalReceived > 0) {
            // Money turned up at an address we had written off. The message is now the
            // only record of what it was for, so nothing here touches it.
            if (await recordUnexpectedPayment(db, row, stats)) funded++;
            else kept++;
            continue;
        }

        const bytes = row.message ? Buffer.byteLength(row.message, 'utf8') : null;
        const claim = await dbRun(
            db,
            // message is NOT NULL in the original schema, so it is emptied rather than
            // nulled — redactedAt is the marker, not the message value. userFeedback and
            // targetAddress arrived via ALTER TABLE and are nullable.
            `UPDATE requests
             SET message = '', userFeedback = NULL, targetAddress = NULL,
                 messageBytes = COALESCE(messageBytes, ?),
                 redactedAt = ?
             WHERE id = ?
               AND archivedAt IS NOT NULL
               AND redactedAt IS NULL
               AND ${UNTOUCHED_BY_MONEY}`,
            [bytes, new Date().toISOString(), row.id]
        );
        if (claim.changes !== 1) { kept++; continue; }

        await dbRun(db, 'UPDATE request_events SET detail = NULL WHERE requestId = ?', [row.id]);
        events.record(db, row.id, events.KINDS.REDACTED, `content dropped after ${config.REDACT_ARCHIVED_AFTER_MS / 86400000} days; ${bytes ?? '?'} message bytes`);
        redacted++;
        console.log(`[Cleanup] Redacted content of archived request ${row.id} (row and address kept).`);
    }

    if (redacted > 0 || funded > 0) {
        console.log(`[Cleanup] Redaction complete. Redacted: ${redacted}, funded-and-spared: ${funded}, kept: ${kept}.`);
    }
    return { redacted, funded, kept };
}

/**
 * Asks BlockCypher what it is actually holding, and deletes what nothing needs.
 *
 * Every other pass above reasons from our own tables, and our own tables cannot see this
 * failure: a delete that silently did not land leaves a row saying "retired" and a hook
 * that is still live. Only BlockCypher knows the difference, so something has to ask it on
 * a schedule rather than when a human happens to wonder. The 22 orphans found on
 * 2026-08-07 had been accumulating unseen for months.
 *
 * In steady state this finds nothing and costs one API call. Anything it does find means
 * the bookkeeping drifted, so it says so loudly enough to reach the admin panel's event
 * feed via console.warn.
 */
async function sweepOrphanedWebhooks(db) {
    if (!config.WEBHOOK_SWEEP_ENABLED) return { deleted: 0, skipped: 0 };

    const result = await webhookReconcile.pruneOrphanedWebhooks(db, config, {
        limit: webhookReconcile.MAX_DELETES_PER_SWEEP,
    });

    if (result.ok === false) {
        console.warn(`[Cleanup] Could not reconcile webhooks against BlockCypher: ${result.reason}`);
        return { deleted: 0, skipped: 0 };
    }

    const cleaned = result.deleted + result.alreadyGone;
    if (cleaned > 0 || result.failed > 0) {
        console.warn(`[Cleanup] Orphaned webhook sweep: deleted ${result.deleted}, already gone `
            + `${result.alreadyGone}, in use ${result.skipped}, failed ${result.failed}`
            + `${result.remaining ? `, ${result.remaining} left for the next pass` : ''}`
            + `${result.rateLimited ? ' (BlockCypher rate limit reached)' : ''}.`);
        if (result.errors.length) console.warn(`[Cleanup] Sweep errors: ${result.errors.join('; ')}`);
    }
    return { deleted: result.deleted, skipped: result.skipped };
}

/**
 * The scheduled retention job. Retires webhooks first so an address stops costing quota
 * as early as possible, then decides which rows are finished with, then — much later —
 * drops the content of the ones nobody ever paid. The orphan sweep runs last, so it sees
 * this pass's own retirements and archives rather than chasing them next time.
 */
async function cleanupOldRequests(db) {
    try {
        await retireStaleWebhooks(db);
        await archiveAbandonedRequests(db);
        await redactOldArchivedRequests(db);
        await sweepOrphanedWebhooks(db);
    } catch (error) {
        console.error('[Cleanup] Error during cleanup:', error.message);
    }
}

module.exports = {
    cleanupOldRequests,
    retireStaleWebhooks,
    archiveAbandonedRequests,
    redactOldArchivedRequests,
    sweepOrphanedWebhooks,
};
