// backend/src/notifier.js
//
// Sends Telegram notifications about service activity.
//
// Design rules, in order of importance:
//   1. A notification failure must NEVER affect a payment. Every send is fire-and-forget
//      and swallows its own errors — Telegram being down must not stop an OP_RETURN.
//   2. Never spam. A rolling hourly cap protects against a retry loop turning into
//      hundreds of messages.
//   3. Never leak secrets. Only the token is sensitive and it is only ever used to build
//      the request URL; it is never logged.
//
// Disabled automatically when the bot token or chat id are absent, so the service runs
// exactly as before if notifications are not configured.

const axios = require('axios');

const SEND_TIMEOUT_MS = 15000;
const MAX_PER_HOUR = 40;
const WINDOW_MS = 60 * 60 * 1000;

let sentTimestamps = [];
let suppressedCount = 0;
let warnedDisabled = false;

/** Telegram HTML mode needs these escaped, otherwise a customer message can break the send. */
function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function truncate(value, max = 300) {
    const s = String(value ?? '');
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

function isEnabled(config) {
    return !!(config && config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID && config.NOTIFY_ENABLED);
}

function withinRateLimit() {
    const cutoff = Date.now() - WINDOW_MS;
    sentTimestamps = sentTimestamps.filter((t) => t > cutoff);
    if (sentTimestamps.length >= MAX_PER_HOUR) {
        suppressedCount++;
        if (suppressedCount === 1) {
            console.warn(`[Notifier] Hourly notification cap (${MAX_PER_HOUR}) reached — suppressing further messages this hour.`);
        }
        return false;
    }
    if (suppressedCount > 0) {
        console.warn(`[Notifier] Resuming notifications; ${suppressedCount} were suppressed.`);
        suppressedCount = 0;
    }
    sentTimestamps.push(Date.now());
    return true;
}

/**
 * Sends a message. Returns a promise that always resolves — callers are not expected
 * to await it and must never have their own work fail because of it.
 */
async function send(text, config) {
    if (!isEnabled(config)) {
        if (!warnedDisabled) {
            warnedDisabled = true;
            console.log('[Notifier] Telegram notifications are not configured — skipping.');
        }
        return { ok: false, reason: 'disabled' };
    }
    if (!withinRateLimit()) {
        return { ok: false, reason: 'rate_limited' };
    }

    try {
        const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const res = await axios.post(
            url,
            {
                chat_id: config.TELEGRAM_CHAT_ID,
                text,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            },
            { timeout: SEND_TIMEOUT_MS }
        );
        if (res.data && res.data.ok) {
            return { ok: true, messageId: res.data.result?.message_id };
        }
        console.warn(`[Notifier] Telegram rejected the message: ${res.data?.description || 'unknown'}`);
        return { ok: false, reason: res.data?.description || 'rejected' };
    } catch (error) {
        // Deliberately swallowed: never surface a notification problem to the caller.
        const detail = error?.response?.data?.description || error.message;
        console.warn(`[Notifier] Could not send Telegram message: ${detail}`);
        return { ok: false, reason: detail };
    }
}

/** Fire-and-forget wrapper used by the lifecycle hooks. */
function fire(text, config) {
    Promise.resolve()
        .then(() => send(text, config))
        .catch((e) => console.warn('[Notifier] Unexpected notifier error:', e.message));
}

const shortId = (id) => String(id || '').substring(0, 8);

// --- Lifecycle notifications ---------------------------------------------

function notifyNewOrder({ requestId, message, requiredAmountSatoshis, targetAddress }, config) {
    fire(
        `🟡 <b>New order</b>\n\n` +
        `<i>"${esc(truncate(message, 200))}"</i>\n\n` +
        `Awaiting <b>${esc(requiredAmountSatoshis)} sats</b>` +
        (targetAddress ? `\nRecipient: <code>${esc(targetAddress)}</code>` : '') +
        `\nOrder <code>${esc(shortId(requestId))}</code>`,
        config
    );
}

function notifyPaymentReceived({ requestId, amount, message }, config) {
    fire(
        `💰 <b>Payment received</b> — ${esc(amount)} sats\n\n` +
        `<i>"${esc(truncate(message, 200))}"</i>\n\n` +
        `Publishing now…\nOrder <code>${esc(shortId(requestId))}</code>`,
        config
    );
}

function notifyDelivered({ requestId, message, opReturnTxId }, config) {
    fire(
        `✅ <b>Published to the blockchain</b>\n\n` +
        `<i>"${esc(truncate(message, 200))}"</i>\n\n` +
        `https://mempool.space/tx/${esc(opReturnTxId)}\n` +
        `Order <code>${esc(shortId(requestId))}</code>`,
        config
    );
}

function notifyFailed({ requestId, message, reason, amount, terminal, refund }, config) {
    let refundLine = '';
    if (refund?.ok) {
        refundLine = `\n\n↩️ Automatically refunded ${esc(refund.amount)} sats.`;
    } else if (terminal) {
        refundLine = `\n\n⚠️ <b>Not refunded automatically</b> (${esc(refund?.reason || 'no refund possible')}). Needs you.`;
    }

    fire(
        `${terminal ? '🔴' : '🟠'} <b>Order ${terminal ? 'FAILED' : 'failed — will retry'}</b>\n\n` +
        `<i>"${esc(truncate(message, 200))}"</i>\n\n` +
        (amount ? `Customer paid: <b>${esc(amount)} sats</b>\n` : '') +
        `Reason: ${esc(truncate(reason, 200))}` +
        refundLine +
        `\n\nOrder <code>${esc(shortId(requestId))}</code>`,
        config
    );
}

function notifyRefunded({ requestId, amount, refundTxId, refundAddress }, config) {
    fire(
        `↩️ <b>Refund sent</b> — ${esc(amount)} sats\n\n` +
        `To: <code>${esc(refundAddress)}</code>\n` +
        `https://mempool.space/tx/${esc(refundTxId)}\n` +
        `Order <code>${esc(shortId(requestId))}</code>`,
        config
    );
}

function notifyCustomerMessage({ requestId, feedback }, config) {
    fire(
        `💬 <b>A customer wrote to you</b>\n\n` +
        `<i>"${esc(truncate(feedback, 500))}"</i>\n\n` +
        `About failed order <code>${esc(shortId(requestId))}</code>`,
        config
    );
}

module.exports = {
    send,
    isEnabled,
    notifyNewOrder,
    notifyPaymentReceived,
    notifyDelivered,
    notifyFailed,
    notifyRefunded,
    notifyCustomerMessage,
    MAX_PER_HOUR,
};
