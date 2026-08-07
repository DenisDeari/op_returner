// backend/src/webhook_reconcile.js
//
// What BlockCypher actually holds, reconciled against what the database believes.
//
// The database's view of webhook state is a hope, not a fact: `deleteWebhook` returns
// undefined on every path — missing token, 204, 404, network error — so "we retired this"
// has only ever meant "we asked". On 2026-08-07 the first real comparison found 24 hooks
// registered and 2 in use: 22 belonged to rows hard-deleted before archiving existed, each
// one quietly holding a slice of the free-tier allowance the payment path depends on.
//
// Hard deletion is gone, so that particular source is closed. This exists because the
// mechanism that hid it is not: a delete we cannot confirm can always fail silently, and
// nothing that reads only our own tables will ever notice. Only BlockCypher knows.
//
// A hook is judged by ADDRESS as well as by id, and that is the load-bearing part. A row
// is inserted before `registerWebhook` is called and its hook ids are written after — a
// window of five to ten seconds, since the two registrations are deliberately spaced to
// dodge a rate limit. Inside that window a live hook is claimed by no row's id column. An
// id-only rule calls it orphaned and deletes the webhook watching a customer who is about
// to pay. Matching the address as well closes that window, and costs nothing: addresses
// are UNIQUE per row and never reused.

const webhookManager = require('./webhook_manager');
const { dbAll } = require('./db_utils');

// BlockCypher stops accepting deletes after roughly twenty in a burst — observed on
// 2026-08-07, when pruning 22 orphans deleted 21 and failed the last with "Limits
// reached." A scheduled sweep stays well under that: whatever is left waits for the next
// pass, which costs nothing, rather than burning quota on calls that will be refused.
const MAX_DELETES_PER_SWEEP = 15;

/**
 * Every request row indexed both ways — by each hook id it claims, and by its address.
 */
async function loadOwners(db) {
    const rows = await dbAll(
        db,
        `SELECT id, address, status, blockcypherHookId, webhooksRetiredAt,
                archivedAt, opReturnTxId, refundTxId
         FROM requests`
    );

    const byHookId = new Map();
    const byAddress = new Map();
    for (const row of rows) {
        if (row.address) byAddress.set(row.address, row);
        if (!row.blockcypherHookId) continue;
        for (const raw of String(row.blockcypherHookId).split(',')) {
            const hookId = raw.trim();
            if (hookId) byHookId.set(hookId, row);
        }
    }
    return { byHookId, byAddress };
}

/**
 * Decides whether one live hook is still doing a job.
 *
 * Deliberately conservative in one direction only: anything that might still be watching
 * a payment is kept. The cost of keeping a hook too long is a little quota; the cost of
 * deleting one too early is a payment nobody is told about.
 */
function judgeHook(hook, owners) {
    // The address match is what covers a registration still in flight, where the row
    // exists but has not been given its hook ids yet.
    const owner = owners.byHookId.get(hook.id)
        || (hook.address ? owners.byAddress.get(hook.address) : null)
        || null;

    if (!owner) {
        return { owner: null, stillNeeded: false, reason: 'no request claims this hook' };
    }

    const stillNeeded = !owner.webhooksRetiredAt
        && !owner.archivedAt
        && !owner.opReturnTxId
        && !owner.refundTxId;

    const reason = stillNeeded ? 'in use'
        : owner.webhooksRetiredAt ? 'request already retired'
        : owner.archivedAt ? 'request archived'
        : 'request already settled';

    return { owner, stillNeeded, reason };
}

/**
 * Read-only: what is registered, what still has a job, what is waste.
 *
 * @returns {Promise<{ok: true, total, inUse, orphaned, hooks: Array} | {ok: false, reason: string}>}
 */
async function reconcileWebhooks(db, config) {
    const listed = await webhookManager.listWebhooks(config);
    if (!listed.ok) return { ok: false, reason: listed.reason };

    const owners = await loadOwners(db);
    const hooks = listed.hooks.map((hook) => {
        const { owner, stillNeeded, reason } = judgeHook(hook, owners);
        return {
            ...hook,
            requestId: owner ? owner.id : null,
            requestStatus: owner ? owner.status : null,
            reason,
            orphaned: !stillNeeded,
        };
    });

    return {
        ok: true,
        total: hooks.length,
        inUse: hooks.filter((h) => !h.orphaned).length,
        orphaned: hooks.filter((h) => h.orphaned).length,
        hooks,
    };
}

/**
 * Deletes the hooks nothing needs any more.
 *
 * Re-derives the judgement from the database itself rather than trusting anything a caller
 * passed in, and reports deleted / already-gone / failed separately so it can never claim
 * a cleanup it did not achieve. Stops early on a rate limit: once BlockCypher is refusing
 * deletes, every further call is a wasted request against the same allowance this is
 * supposed to be protecting.
 *
 * @param {number} [options.limit] hard cap on deletions this run
 */
async function pruneOrphanedWebhooks(db, config, options = {}) {
    const limit = Number.isFinite(options.limit) ? options.limit : MAX_DELETES_PER_SWEEP;

    const listed = await webhookManager.listWebhooks(config);
    if (!listed.ok) return { ok: false, reason: listed.reason };

    const owners = await loadOwners(db);
    const results = {
        ok: true, deleted: 0, alreadyGone: 0, failed: 0, skipped: 0,
        remaining: 0, rateLimited: false, errors: [],
    };

    for (const hook of listed.hooks) {
        const { stillNeeded } = judgeHook(hook, owners);
        if (stillNeeded) { results.skipped++; continue; }

        const attempted = results.deleted + results.alreadyGone + results.failed;
        if (results.rateLimited || attempted >= limit) { results.remaining++; continue; }

        const out = await webhookManager.deleteWebhookById(hook.id, config);
        if (out.ok && out.alreadyGone) results.alreadyGone++;
        else if (out.ok) results.deleted++;
        else {
            results.failed++;
            results.errors.push(`${hook.id}: ${out.reason}`);
            if (/limit/i.test(String(out.reason))) results.rateLimited = true;
        }
    }

    return results;
}

module.exports = {
    reconcileWebhooks,
    pruneOrphanedWebhooks,
    judgeHook,
    loadOwners,
    MAX_DELETES_PER_SWEEP,
};
