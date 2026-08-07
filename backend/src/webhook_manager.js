const axios = require('axios');

async function registerWebhook(btcAddress, config) {
    if (!config.BLOCKCYPHER_TOKEN) {
        console.warn("BLOCKCYPHER_TOKEN not found. Skipping webhook registration.");
        return null;
    }
    const webhookUrl = `${config.WEBHOOK_RECEIVER_BASE_URL}/api/webhook/payment-notification`;
    const apiUrl = `${config.BLOCKCYPHER_API_BASE}/hooks?token=${config.BLOCKCYPHER_TOKEN}`;
    
    const events = ["unconfirmed-tx", "confirmed-tx"];
    const hookIds = [];

    console.log(`Registering webhooks for ${btcAddress}...`);

    for (let i = 0; i < events.length; i++) {
        const eventType = events[i];

        // Add 5s delay for subsequent requests to avoid rate limits
        if (i > 0) {
            console.log("Waiting 5 seconds before registering next webhook...");
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        const payload = { event: eventType, address: btcAddress, url: webhookUrl };
        try {
            const response = await axios.post(apiUrl, payload);
            console.log(`Successfully registered ${eventType} webhook. ID: ${response.data.id}`);
            hookIds.push(response.data.id);
        } catch (error) {
            console.error(`Error registering ${eventType} webhook:`, error.message);
            if (error.response) {
                // console.error('API Error Status:', error.response.status, 'Data:', error.response.data);
                if (error.response.status === 429) {
                    console.warn("Rate limit exceeded during webhook registration.");
                }
            }
        }
    }
    return hookIds.length > 0 ? hookIds.join(',') : null;
}

async function deleteWebhook(hookIdString, config) {
    if (!hookIdString || !config.BLOCKCYPHER_TOKEN) return;

    const hookIds = hookIdString.split(',');
    const apiUrlBase = `${config.BLOCKCYPHER_API_BASE}/hooks`;

    for (const hookId of hookIds) {
        const apiUrl = `${apiUrlBase}/${hookId}?token=${config.BLOCKCYPHER_TOKEN}`;
        try {
            await axios.delete(apiUrl);
            console.log(`Successfully deleted webhook ID: ${hookId}`);
        } catch (error) {
            console.error(`Error deleting webhook ${hookId}:`, error.message);
            if (error.response && error.response.status === 404) {
                console.log("Webhook already deleted or not found.");
            }
        }
    }
}

/**
 * Every webhook currently registered against this BlockCypher token.
 *
 * Read-only, and the missing half of the picture. `deleteWebhook` cannot report success —
 * missing token, 204, 404 and a network error are all indistinguishable `undefined` — so
 * the database's idea of which hooks are gone has always been a hope rather than a fact.
 * Roughly forty request rows were hard-deleted before archiving existed, each firing an
 * unawaited delete, and nothing in this codebase could tell you whether those hooks are
 * still live and still consuming the free-tier allowance the payment path depends on.
 *
 * @returns {Promise<{ok: true, hooks: Array<{id, event, address, url}>} | {ok: false, reason: string}>}
 */
async function listWebhooks(config) {
    if (!config.BLOCKCYPHER_TOKEN) {
        return { ok: false, reason: 'no BlockCypher token configured' };
    }
    try {
        const res = await axios.get(`${config.BLOCKCYPHER_API_BASE}/hooks?token=${config.BLOCKCYPHER_TOKEN}`, { timeout: 15000 });
        const hooks = Array.isArray(res.data) ? res.data : [];
        return {
            ok: true,
            hooks: hooks.map((h) => ({
                id: h.id,
                event: h.event,
                address: h.address || null,
                url: h.url || null,
            })),
        };
    } catch (error) {
        const detail = error?.response?.data?.error || error.message;
        console.warn(`[WebhookManager] Could not list webhooks: ${detail}`);
        return { ok: false, reason: detail };
    }
}

/**
 * Deletes one hook by id and reports whether it is now gone.
 *
 * Unlike `deleteWebhook`, this distinguishes outcomes: a 404 counts as success, because
 * the hook not being there is the state we wanted. Used by the orphan sweep, which must
 * not claim to have cleaned up something it could not reach.
 *
 * @returns {Promise<{ok: boolean, alreadyGone?: boolean, reason?: string}>}
 */
async function deleteWebhookById(hookId, config) {
    if (!hookId || !config.BLOCKCYPHER_TOKEN) return { ok: false, reason: 'missing hook id or token' };
    try {
        await axios.delete(`${config.BLOCKCYPHER_API_BASE}/hooks/${hookId}?token=${config.BLOCKCYPHER_TOKEN}`, { timeout: 15000 });
        return { ok: true };
    } catch (error) {
        if (error?.response?.status === 404) return { ok: true, alreadyGone: true };
        return { ok: false, reason: error?.response?.data?.error || error.message };
    }
}

/**
 * Deletes every hook in a comma-joined id pair and reports what actually happened.
 *
 * The awaited, answerable counterpart to `deleteWebhook`. A caller that records "these
 * hooks are retired" needs to know whether they are, because that record is what stops
 * anything looking at the row again — and BlockCypher refuses deletes in bursts, so the
 * failure is real and arrives exactly when a batch is being cleaned up.
 *
 * No token means no hooks were ever registered, so there is nothing to fail at.
 *
 * @returns {Promise<{ok: boolean, deleted: number, alreadyGone: number, failed: number, reasons: string[]}>}
 */
async function deleteWebhookIds(hookIdString, config) {
    const out = { ok: true, deleted: 0, alreadyGone: 0, failed: 0, reasons: [] };
    if (!hookIdString || !config.BLOCKCYPHER_TOKEN) return out;

    for (const raw of String(hookIdString).split(',')) {
        const hookId = raw.trim();
        if (!hookId) continue;
        const res = await deleteWebhookById(hookId, config);
        if (res.ok && res.alreadyGone) out.alreadyGone++;
        else if (res.ok) out.deleted++;
        else {
            out.failed++;
            out.ok = false;
            out.reasons.push(`${hookId}: ${res.reason}`);
        }
    }
    return out;
}

module.exports = { registerWebhook, deleteWebhook, listWebhooks, deleteWebhookById, deleteWebhookIds };
