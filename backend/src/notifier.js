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
const crypto = require('crypto');
const payload = require('./payload');

const SEND_TIMEOUT_MS = 15000;
const MAX_PER_HOUR = 40;
const WINDOW_MS = 60 * 60 * 1000;

// Telegram's own limits on sendPhoto. The caption ceiling is the one that bites: a caption
// over it is rejected outright, and truncating HTML mid-tag turns that into a parse error
// instead. We check and fall back to a text message rather than cutting.
const CAPTION_MAX_CHARS = 1024;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/** The filename Telegram sees. It only ever comes from this closed map, never from a row. */
const PHOTO_FILENAMES = {
    'image/webp': 'payload.webp',
    'image/jpeg': 'payload.jpg',
};

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

/**
 * A multipart/form-data body, built by hand.
 *
 * Node 18 has global FormData and Blob but no global File, and `require('node:buffer').File`
 * prints an ExperimentalWarning — axios only emits `filename="…"` when the part has a `.name`,
 * and Telegram treats a part without a filename as a plain string field rather than an upload.
 * So the choice was an experimental API or twenty legible lines. In a repository that moves
 * money, twenty legible lines win: this has no version-dependent behaviour to be surprised by,
 * and the test can assert the exact bytes on the wire.
 *
 * The boundary is 24 random bytes. A caption containing it would corrupt the body, so the
 * caller checks rather than assuming — see sendPhoto.
 */
function buildMultipart(boundary, fields, file) {
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
            'utf8'
        ));
    }
    parts.push(Buffer.from(
        `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`
        + `Content-Type: ${file.contentType}\r\n\r\n`,
        'utf8'
    ));
    parts.push(file.bytes);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    return Buffer.concat(parts);
}

/**
 * Sends the picture WITH its caption, in a single Telegram call.
 *
 * The caption replaces the text message rather than following it, and that is deliberate:
 * withinRateLimit() is a global hourly cap shared by every notification type, so a photo sent
 * as a second call would halve how many orders the operator hears about in a busy hour.
 *
 * Everything that can fail is decided BEFORE a rate-limit slot is spent, so a photo we end up
 * not sending does not cost the operator the text message that replaces it.
 *
 * Same contract as send(): always resolves, never throws. payload.decode() throws on a row
 * that does not decode, and these functions are called from the middle of building and
 * broadcasting transactions — a throw here would surface as a failed order.
 */
async function sendPhoto(caption, message, payloadKind, config) {
    if (!isEnabled(config)) return { ok: false, reason: 'disabled' };

    const boundary = `----satwire${crypto.randomBytes(24).toString('hex')}`;
    let body;
    try {
        if (!payload.isImage(payloadKind)) return { ok: false, reason: 'not an image payload' };
        if (caption.length > CAPTION_MAX_CHARS) return { ok: false, reason: 'caption too long' };
        // Cannot happen with a random 48-hex boundary, but the failure mode if it ever did
        // is a corrupted upload rather than an error, so it is checked rather than assumed.
        if (caption.includes(boundary)) return { ok: false, reason: 'boundary collision' };

        const bytes = payload.decode(message, payloadKind);
        if (!bytes.length || bytes.length > PHOTO_MAX_BYTES) return { ok: false, reason: 'payload size' };

        body = buildMultipart(
            boundary,
            {
                chat_id: String(config.TELEGRAM_CHAT_ID),
                caption,
                parse_mode: 'HTML',
            },
            {
                field: 'photo',
                // From the closed map above, never from the row: the filename and the type
                // are ours to state, and a row claiming something else is not an image here.
                filename: PHOTO_FILENAMES[payloadKind],
                contentType: payloadKind,
                bytes,
            }
        );
    } catch (error) {
        return { ok: false, reason: `payload: ${error.message}` };
    }

    if (!withinRateLimit()) return { ok: false, reason: 'rate_limited' };

    try {
        const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendPhoto`;
        const res = await axios.post(url, body, {
            timeout: SEND_TIMEOUT_MS,
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length,
            },
            maxBodyLength: Infinity,
        });
        if (res.data && res.data.ok) {
            return { ok: true, messageId: res.data.result?.message_id };
        }
        return { ok: false, reason: res.data?.description || 'rejected' };
    } catch (error) {
        const detail = error?.response?.data?.description || error.message;
        return { ok: false, reason: detail };
    }
}

/**
 * Fire-and-forget wrapper used by the lifecycle hooks.
 *
 * `image` is optional and is `{ message, payloadKind }` straight off the row. When it names
 * an image, the operator gets the actual picture with the same caption they would have got as
 * text; anything at all going wrong falls back to the text message, because a notification
 * that arrives is worth more than one that would have been prettier.
 *
 * The decode happens inside this promise, never in the caller's stack. `fire(...)` is called
 * from the middle of request_service.js's fulfil path, whose catch turns any throw into
 * `{ success: false }` — after the OP_RETURN has already been broadcast.
 */
function fire(text, config, image) {
    Promise.resolve()
        .then(async () => {
            if (image && image.message && payload.isImage(image.payloadKind)) {
                const shot = await sendPhoto(text, image.message, image.payloadKind, config);
                if (shot.ok) return shot;
                console.warn(`[Notifier] Photo not sent (${shot.reason}) — sending text instead.`);
            }
            return send(text, config);
        })
        .catch((e) => console.warn('[Notifier] Unexpected notifier error:', e.message));
}

const shortId = (id) => String(id || '').substring(0, 8);

/**
 * The quoted line every lifecycle notification opens with.
 *
 * Centralised here rather than at the four call sites on purpose. An image order stores
 * base64 in `message`, so `truncate(message, 200)` sends the operator 200 characters of
 * gibberish — and the operator reading these is how orders actually get looked at. Doing
 * it in one place means a notification added later cannot quietly get it wrong.
 *
 * Callers pass the row's payloadKind; absent, payload.describe treats it as text, which
 * is what every row written before images existed is.
 */
function preview(message, payloadKind) {
    return esc(truncate(payload.describe(message, payloadKind), 200));
}

// --- Lifecycle notifications ---------------------------------------------

function notifyNewOrder({ requestId, message, payloadKind, requiredAmountSatoshis, targetAddress }, config) {
    fire(
        `🟡 <b>New order</b>\n\n` +
        `<i>"${preview(message, payloadKind)}"</i>\n\n` +
        `Awaiting <b>${esc(requiredAmountSatoshis)} sats</b>` +
        (targetAddress ? `\nRecipient: <code>${esc(targetAddress)}</code>` : '') +
        `\nOrder <code>${esc(shortId(requestId))}</code>`,
        config,
        { message, payloadKind }
    );
}

function notifyPaymentReceived({ requestId, amount, message, payloadKind }, config) {
    fire(
        `💰 <b>Payment received</b> — ${esc(amount)} sats\n\n` +
        `<i>"${preview(message, payloadKind)}"</i>\n\n` +
        `Publishing now…\nOrder <code>${esc(shortId(requestId))}</code>`,
        config,
        { message, payloadKind }
    );
}

function notifyDelivered({ requestId, message, payloadKind, opReturnTxId }, config) {
    fire(
        `✅ <b>Published to the blockchain</b>\n\n` +
        `<i>"${preview(message, payloadKind)}"</i>\n\n` +
        `https://mempool.space/tx/${esc(opReturnTxId)}\n` +
        `Order <code>${esc(shortId(requestId))}</code>`,
        config,
        { message, payloadKind }
    );
}

function notifyFailed({ requestId, message, payloadKind, reason, amount, terminal, refund }, config) {
    let refundLine = '';
    if (refund?.ok) {
        refundLine = `\n\n↩️ Automatically refunded ${esc(refund.amount)} sats.`;
    } else if (terminal) {
        refundLine = `\n\n⚠️ <b>Not refunded automatically</b> (${esc(refund?.reason || 'no refund possible')}). Needs you.`;
    }

    fire(
        `${terminal ? '🔴' : '🟠'} <b>Order ${terminal ? 'FAILED' : 'failed — will retry'}</b>\n\n` +
        `<i>"${preview(message, payloadKind)}"</i>\n\n` +
        (amount ? `Customer paid: <b>${esc(amount)} sats</b>\n` : '') +
        `Reason: ${esc(truncate(reason, 200))}` +
        refundLine +
        `\n\nOrder <code>${esc(shortId(requestId))}</code>`,
        config,
        { message, payloadKind }
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

/**
 * An order that was about to be archived turns out to hold money.
 *
 * Deliberately not part of the automatic lifecycle: nothing will fulfil or refund this
 * row, because it was abandoned days ago and a timer should not decide what happens to
 * money that arrived late. This message is the handover to a human.
 */
function notifyArchiveFunded({ requestId, address, amount, refundAddress, createdAt }, config) {
    fire(
        `⚠️ <b>Unexpected payment on an abandoned order</b>\n`
        + `Order: <code>${esc(shortId(requestId))}</code>\n`
        + `Ordered: ${esc(String(createdAt || '').slice(0, 10))}\n`
        + `Address: <code>${esc(address)}</code>\n`
        + `Holds: <b>${esc(amount)}</b> sats\n`
        + `Refund to: <code>${esc(refundAddress || 'UNKNOWN — resolve by hand')}</code>\n\n`
        + `It was NOT archived and nothing automatic will touch it. `
        + `Fulfil or refund it from the admin panel.`,
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
    sendPhoto,
    buildMultipart,
    isEnabled,
    CAPTION_MAX_CHARS,
    PHOTO_FILENAMES,
    notifyNewOrder,
    notifyPaymentReceived,
    notifyDelivered,
    notifyFailed,
    notifyRefunded,
    notifyCustomerMessage,
    notifyArchiveFunded,
    MAX_PER_HOUR,
};
