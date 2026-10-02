// backend/src/lightning.js
//
// Lightning payments, through a phoenixd node on the same Docker network.
//
// A Lightning payment hands the service no UTXO, so the OP_RETURN transaction cannot be
// paid for out of the customer's own payment the way an on-chain order is. The treasury
// (treasury.js, m/84'/0'/0'/2/0) pays for it instead, and the Lightning income piles up in
// phoenixd until the operator sweeps it back on-chain into the treasury.
//
// THE LIFECYCLE OF A LIGHTNING ORDER
//
//   intake      routes/api.js prices it (quote below), checks the treasury can actually
//               cover it (treasuryCapacity), writes the row, and asks phoenixd for an
//               invoice carrying the request id as its externalId.
//   payment     phoenixd calls our webhook; the customer's status poll and the reconcile
//               pass also ask. All three go through checkInvoice, which reads the payment
//               from phoenixd by hash and NEVER from the webhook body.
//   publishing  request_service.js routes the row to fulfilLightning, which spends from
//               the treasury and records the signed transaction on the row BEFORE it is
//               broadcast.
//   refund      there is no payer address to send money back to, so when an order
//               terminally fails the customer gives us a Lightning address and
//               attemptLightningRefund pays it.
//
// RULES THIS FILE KEEPS
//
//   - Never take money for a transaction we cannot broadcast. An invoice is only issued
//     once the treasury has been seen to hold enough for this order AND every other open
//     Lightning order, and the order is under the treasury's per-spend ceiling.
//   - A webhook body is a doorbell, not evidence. phoenixd signs it, and we check the
//     signature, but even a correctly signed body only triggers a lookup.
//   - A paid order is marked with `paymentTxId = 'ln:<paymentHash>'`, so every existing
//     "is this paid?" check in the service sees it. See the note in schema.js.
//   - A refund is paid at most once. An outcome we cannot read is never retried
//     automatically: it goes to a human, because a second attempt would pay twice.

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const appConfig = require('./config');
const txSizing = require('./tx_sizing');
const treasury = require('./treasury');
const chainProviders = require('./chain_providers');
const notifier = require('./notifier');
const events = require('./request_events');
const { dbGet, dbAll, dbRun } = require('./db_utils');
const { isPermanentReason, isNoRefundReason } = require('./failure_reasons');

const LIGHTNING = 'lightning';
const LN_TX_PREFIX = 'ln:';

// After an invoice expires, how long to wait before calling the order dead. A payment
// whose HTLCs arrived just before expiry can complete a little after it; archiving at the
// exact second would turn that customer's successful payment into a "paid after expiry"
// refund case.
const EXPIRY_GRACE_MS = 5 * 60 * 1000;

// How often one order's invoice may be looked up on behalf of its status poll. The
// browser polls every 5 seconds per open order; phoenixd is local and cheap, but a page
// left open with ten orders is still two lookups a second for nothing.
const STATUS_CHECK_MIN_INTERVAL_MS = 3000;

// phoenixd answers a pay call only once the payment has settled or failed, which can
// take a while across several routes. Generous, because a timeout here is the one
// outcome that cannot be retried (see attemptLightningRefund).
const PAY_TIMEOUT_MS = 120 * 1000;
const READ_TIMEOUT_MS = 10 * 1000;

function isLightningRow(row) {
    return !!row && row.paymentMethod === LIGHTNING;
}

function isLightningRef(value) {
    return typeof value === 'string' && value.startsWith(LN_TX_PREFIX);
}

// --- phoenixd ---------------------------------------------------------------

function phoenixdAuth(config) {
    // phoenixd's basic auth checks the password only; the username is ignored.
    return { username: 'satwire', password: config.PHOENIXD_PASSWORD };
}

function describeAxiosError(error) {
    if (error && error.response) {
        const body = typeof error.response.data === 'string'
            ? error.response.data
            : JSON.stringify(error.response.data);
        return `HTTP ${error.response.status}: ${String(body || '').slice(0, 300)}`;
    }
    return (error && (error.code || error.message)) || 'unknown error';
}

async function phoenixdGet(config, path, params, timeout = READ_TIMEOUT_MS) {
    return axios.get(`${config.PHOENIXD_URL}${path}`, {
        auth: phoenixdAuth(config),
        params,
        timeout,
    });
}

async function phoenixdPost(config, path, params, timeout = READ_TIMEOUT_MS) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
        if (v !== undefined && v !== null) body.append(k, String(v));
    }
    return axios.post(`${config.PHOENIXD_URL}${path}`, body.toString(), {
        auth: phoenixdAuth(config),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout,
    });
}

/**
 * Asks phoenixd for a BOLT11 invoice. The request id travels as externalId, so a payment
 * can always be traced back to the row it pays for — checkInvoice refuses one that does
 * not carry it.
 *
 * @returns {Promise<{ok: true, paymentHash: string, invoice: string} | {ok: false, reason: string}>}
 */
async function createInvoice(config, { amountSat, description, externalId, expirySeconds }) {
    try {
        const res = await phoenixdPost(config, '/createinvoice', {
            amountSat, description, externalId, expirySeconds,
        });
        const d = res.data || {};
        if (!/^[0-9a-f]{64}$/.test(String(d.paymentHash || '')) || typeof d.serialized !== 'string') {
            return { ok: false, reason: 'malformed createinvoice response' };
        }
        return { ok: true, paymentHash: d.paymentHash, invoice: d.serialized };
    } catch (error) {
        return { ok: false, reason: describeAxiosError(error) };
    }
}

/**
 * One incoming payment, by hash. `found: false` only on phoenixd's own 404; any other
 * failure is `ok: false` — an unreadable answer is never reported as "not paid".
 */
async function getIncomingPayment(config, paymentHash) {
    if (!/^[0-9a-f]{64}$/.test(String(paymentHash || ''))) {
        return { ok: false, reason: 'not a payment hash' };
    }
    try {
        const res = await phoenixdGet(config, `/payments/incoming/${paymentHash}`);
        return { ok: true, found: true, payment: res.data || {} };
    } catch (error) {
        if (error && error.response && error.response.status === 404) {
            return { ok: true, found: false };
        }
        return { ok: false, reason: describeAxiosError(error) };
    }
}

async function getBalance(config) {
    try {
        const res = await phoenixdGet(config, '/getbalance');
        const d = res.data || {};
        return { ok: true, balanceSat: Number(d.balanceSat) || 0, feeCreditSat: Number(d.feeCreditSat) || 0 };
    } catch (error) {
        return { ok: false, reason: describeAxiosError(error) };
    }
}

async function getInfo(config) {
    try {
        const res = await phoenixdGet(config, '/getinfo');
        return { ok: true, info: res.data || {} };
    } catch (error) {
        return { ok: false, reason: describeAxiosError(error) };
    }
}

/**
 * Pays a Lightning address (user@domain), through phoenixd.
 *
 * Three outcomes, and the third is the reason this is not a boolean:
 *   sent       — phoenixd says the payment settled. `paymentHash` identifies it.
 *   failed     — phoenixd says it did NOT pay: no route, the address did not resolve, a
 *                parameter was refused. Nothing left our node; trying again is safe.
 *   unknown    — the call timed out or the connection dropped. The payment may be in
 *                flight or settled. Trying again could pay twice.
 */
async function payLightningAddress(config, { address, amountSat, message }) {
    try {
        const res = await phoenixdPost(config, '/paylnaddress', { address, amountSat, message }, PAY_TIMEOUT_MS);
        const d = res.data || {};
        if (d.paymentHash && d.paymentPreimage !== undefined && d.recipientAmountSat !== undefined) {
            return {
                outcome: 'sent',
                paymentHash: String(d.paymentHash),
                recipientAmountSat: Number(d.recipientAmountSat),
                routingFeeSat: Number(d.routingFeeSat) || 0,
            };
        }
        if (typeof d.reason === 'string') {
            return { outcome: 'failed', reason: d.reason };
        }
        return { outcome: 'unknown', reason: `unrecognised paylnaddress response: ${JSON.stringify(d).slice(0, 200)}` };
    } catch (error) {
        const status = error && error.response && error.response.status;
        // A 4xx is phoenixd refusing the request outright, before any payment exists. So
        // is an address that never resolved: phoenixd raises "cannot resolve address"
        // before it ever builds an invoice. Everything else — 5xx, timeouts, a dropped
        // connection — is a payment we cannot vouch for.
        const body = String((error && error.response && error.response.data) || '');
        if ((status >= 400 && status < 500) || /cannot resolve address/i.test(body)) {
            return { outcome: 'failed', reason: describeAxiosError(error) };
        }
        return { outcome: 'unknown', reason: describeAxiosError(error) };
    }
}

/**
 * Splices Lightning income out to an on-chain address. Used only by the operator's sweep
 * in routes/admin.js, always to the treasury address.
 */
async function sendToAddress(config, { address, amountSat, feerateSatByte }) {
    try {
        const res = await phoenixdPost(config, '/sendtoaddress', { address, amountSat, feerateSatByte }, 60 * 1000);
        const txId = String(res.data || '').trim();
        if (!/^[0-9a-f]{64}$/.test(txId)) return { ok: false, reason: `unexpected response: ${txId.slice(0, 200)}` };
        return { ok: true, txId };
    } catch (error) {
        return { ok: false, reason: describeAxiosError(error) };
    }
}

/**
 * phoenixd signs every webhook body with HMAC-SHA256 under the webhook secret, hex-encoded
 * in X-Phoenix-Signature. Compared in constant time.
 */
function verifyWebhookSignature(rawBody, signature, secret) {
    if (!rawBody || !signature || !secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    let given;
    try {
        given = Buffer.from(String(signature).trim(), 'hex');
    } catch {
        return false;
    }
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// --- Lightning addresses ------------------------------------------------------

// user@domain, as LUD-16 defines it: the local part is lowercase a-z, 0-9 and -_.+, and
// the domain is an ordinary DNS name with a real top-level label. Deliberately narrow.
// phoenixd fetches https://<domain>/.well-known/lnurlp/<user> on our behalf, so this is
// a URL we are being asked to visit: no IP literals, no ports, no single-label hosts like
// `webapp` that would resolve inside our own Docker network.
const LN_ADDRESS_RE = /^[a-z0-9._+-]{1,64}@(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * True for an address phoenixd must not be sent to fetch from: loopback, private,
 * link-local, carrier-grade NAT, unique-local, unspecified or multicast. The regex above
 * already refuses IP literals and single-label hosts; this catches a public-looking name
 * that resolves somewhere internal (`x@127.0.0.1.nip.io`).
 */
function isPrivateAddress(ip) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (net.isIPv6(ip)) {
        const v = ip.toLowerCase();
        return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
    }
    return true; // not an IP at all: refuse rather than guess
}

let dnsLookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * Whether the domain of a Lightning address resolves only to public addresses.
 * Checked before every refund payment, not once at entry: DNS can change in between.
 * (It cannot stop a rebinding race inside phoenixd; it does stop the plain case.)
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
async function checkAddressHost(address) {
    const host = String(address).split('@')[1] || '';
    let answers;
    try {
        answers = await dnsLookup(host);
    } catch (e) {
        return { ok: false, reason: `the domain ${host} does not resolve (${e.code || e.message})` };
    }
    if (!answers || !answers.length) return { ok: false, reason: `the domain ${host} does not resolve` };
    if (answers.some((a) => isPrivateAddress(a.address))) {
        return { ok: false, reason: `the domain ${host} resolves to a private network address` };
    }
    return { ok: true };
}

/** @returns {{ok: true, address: string} | {ok: false, error: string}} */
function normalizeLightningAddress(input) {
    if (typeof input !== 'string') return { ok: false, error: 'A Lightning address is required.' };
    const address = input.trim().toLowerCase().replace(/^lightning:/, '');
    if (!address) return { ok: false, error: 'A Lightning address is required.' };
    if (address.length > 320 || !LN_ADDRESS_RE.test(address)) {
        return { ok: false, error: 'That does not look like a Lightning address. It should look like name@wallet.com.' };
    }
    return { ok: true, address };
}

// --- Pricing ----------------------------------------------------------------

/**
 * What the treasury actually pays the recipient for this order.
 *
 * Matches op_return_creator.js, not treasury.js's own default. A customer who names an
 * address and no amount is aiming a message AT that address — that is the product — so
 * the address gets the dust limit for its script type, out of the service fee, exactly as
 * an on-chain order does. treasury.js builds no output for a bare address because it was
 * written for the operator's own proofs; a Lightning order is a customer's, so the amount
 * is decided here and passed in.
 *
 * Deterministic in the row, which matters: treasury.js fingerprints amountToSend, and a
 * retry that computed a different number would be refused as a reused idempotency key.
 */
function treasuryRecipientValue({ targetAddress, amountToSend }, config = appConfig) {
    if (!targetAddress) return 0;
    const script = bitcoin.address.toOutputScript(targetAddress, config.NETWORK);
    const dust = txSizing.dustLimitForScript(script, config);
    const asked = amountToSend && amountToSend > 0 ? amountToSend : dust;
    return Math.max(asked, dust);
}

/**
 * The price of a Lightning order, and what it will cost the treasury.
 *
 * Sized with treasury.estimateTreasuryVBytes for one input — the builder's own estimate,
 * safety margin included — rather than queue.js's on-chain formula. queue.js prices four
 * vBytes below what the treasury spends (CLAUDE.md, "What is deliberately not done yet");
 * on-chain the two never meet, and here they would, so the customer is quoted what the
 * builder will actually pay.
 *
 * `messageBytes` is the ON-CHAIN byte count from payload.validate, never the stored length.
 */
function quote({ messageBytes, targetAddress, feeRate, amountToSend }, config = appConfig) {
    const targetScript = targetAddress ? bitcoin.address.toOutputScript(targetAddress, config.NETWORK) : null;
    const recipientValue = treasuryRecipientValue({ targetAddress, amountToSend }, config);
    const vbytes = treasury.estimateTreasuryVBytes(1, messageBytes, recipientValue > 0 ? targetScript : null);
    const rate = Math.max(feeRate || config.DEFAULT_FEE_RATE, config.MIN_EFFECTIVE_FEE_RATE);
    const networkFee = vbytes * rate;
    // The customer pays for what they asked to send. A bare address's dust payout comes
    // out of the service fee, as it does on-chain.
    const customerAmount = targetAddress ? (amountToSend || 0) : 0;
    return {
        vbytes,
        feeRate: rate,
        networkFee,
        serviceFee: config.SERVICE_FEE_SATS,
        customerAmount,
        recipientValue,
        requiredAmountSatoshis: networkFee + config.SERVICE_FEE_SATS + customerAmount,
        treasuryCost: networkFee + recipientValue,
    };
}

/**
 * What an existing Lightning row will cost the treasury when it is published, read back
 * from the row. Uses the quoted price rather than re-estimating, so it is the number the
 * customer agreed to; the recipient payout is recomputed, since a bare address's dust is
 * not part of the price.
 */
function rowTreasuryCost(row, config = appConfig) {
    const customerAmount = row.targetAddress ? (row.amountToSend || 0) : 0;
    let recipient = 0;
    try { recipient = treasuryRecipientValue(row, config); } catch { recipient = customerAmount; }
    const networkFee = Math.max(0, (row.requiredAmountSatoshis || 0) - config.SERVICE_FEE_SATS - customerAmount);
    return networkFee + recipient;
}

// --- Can the treasury pay for this? -------------------------------------------

// How many inputs beyond the first the ceiling check allows for. A treasury that needs
// more than this to pay for one order is fragmented enough that the operator should
// consolidate it; such an order is refused at intake rather than risked after payment.
const EXTRA_INPUTS_ALLOWED = 3;

let spendableCache = null; // { at, spendable }
const SPENDABLE_CACHE_MS = 30 * 1000;

/** Called after every treasury spend, so a stale balance never approves the next order. */
function invalidateTreasuryCache() {
    spendableCache = null;
    // Stale, not gone: the next homepage gets the last answer and triggers a re-check.
    // Clearing it would make the page say "no Lightning" after every single spend.
    if (offerCache) offerCache.at = 0;
}

async function treasurySpendable(rootNode, config) {
    if (spendableCache && Date.now() - spendableCache.at < SPENDABLE_CACHE_MS) {
        return { ok: true, spendable: spendableCache.spendable, cached: true };
    }
    const address = treasury.getTreasuryAddress(rootNode, config.NETWORK);
    const read = await treasury.fetchTreasuryUtxos(address, config);
    if (!read.ok) return { ok: false, reason: read.reason };
    // Through buildCandidates, so outputs this process has just spent are not counted and
    // change it has just made is — the same view a spend would draw on. Outputs too deep
    // in an unconfirmed chain to build on are left out: they are money, but not money
    // that can pay for an order right now.
    const spendable = treasury.buildCandidates(read.utxos)
        .filter((c) => c.depth < treasury.MAX_UNCONFIRMED_DEPTH)
        .reduce((sum, c) => sum + c.value, 0);
    spendableCache = { at: Date.now(), spendable };
    return { ok: true, spendable };
}

/**
 * Everything the treasury has already promised to Lightning orders that are not yet
 * published: invoices still payable, and orders paid and waiting.
 *
 * An expired, unpaid invoice is not counted — phoenixd will refuse to settle it. A paid
 * order stays counted until it is published or refunded, whatever its age. An archived
 * order is never counted: nothing automatic publishes a withdrawn message, so the money
 * it holds goes back to the customer, not to the chain.
 */
async function treasuryReserved(db, config, { excludeId = null } = {}) {
    const rows = await dbAll(
        db,
        `SELECT id, requiredAmountSatoshis, targetAddress, amountToSend FROM requests
         WHERE paymentMethod = 'lightning'
           AND opReturnTxId IS NULL
           AND refundTxId IS NULL
           AND archivedAt IS NULL
           AND (paymentTxId IS NOT NULL OR lnInvoiceExpiresAt > ?)`,
        [new Date().toISOString()]
    );
    return rows
        .filter((r) => r.id !== excludeId)
        .reduce((sum, r) => sum + rowTreasuryCost(r, config), 0);
}

/**
 * Whether the treasury can take on one more Lightning order costing `cost` sats.
 *
 * An unreadable balance is a "no". Refusing a Lightning order sends the customer to the
 * on-chain rail, which needs nothing from the treasury; approving one we cannot see the
 * money for is the failure this whole service is built around.
 */
async function canFund(db, rootNode, config, cost, { feeRate = config.MIN_EFFECTIVE_FEE_RATE } = {}) {
    // The ceiling is checked against the worst this order can actually take out of the
    // treasury, not the one-input price: a fragmented treasury adds 68 vBytes per extra
    // input, and change too small to pay out is absorbed into the fee. An order that only
    // fits the ceiling at one input would be refused as exceeds_max_spend AFTER the
    // customer had paid — which is exactly what intake exists to prevent.
    const worstCase = cost + EXTRA_INPUTS_ALLOWED * 68 * Math.max(feeRate, config.MIN_EFFECTIVE_FEE_RATE) + config.DUST_LIMIT_SATS;
    if (worstCase > config.TREASURY_MAX_SPEND_SATS) {
        return { ok: false, reason: 'over_ceiling', detail: `costs up to ${worstCase} sats, over the ${config.TREASURY_MAX_SPEND_SATS} sat per-transaction ceiling` };
    }
    const balance = await treasurySpendable(rootNode, config);
    if (!balance.ok) return { ok: false, reason: 'balance_unknown', detail: balance.reason };
    const reserved = await treasuryReserved(db, config);
    const headroom = balance.spendable - reserved - config.LN_TREASURY_MARGIN_SATS;
    if (headroom < cost) {
        return {
            ok: false,
            reason: 'treasury_low',
            detail: `treasury holds ${balance.spendable} sats, ${reserved} already promised to open Lightning orders, `
                + `${config.LN_TREASURY_MARGIN_SATS} kept free; this order needs ${cost}`,
            spendable: balance.spendable,
            reserved,
        };
    }
    return { ok: true, spendable: balance.spendable, reserved };
}

// --- One Lightning intake at a time ------------------------------------------------
//
// canFund reads the treasury and what is already promised, and the order only becomes a
// promise once its invoice is written. Two orders arriving together would both see the
// same room and both be accepted. Holding this from the check to the invoice closes that.
// Per process, which is all there is (see the note on withTreasuryLock).
let intakeTail = Promise.resolve();

/** @returns {Promise<function>} resolves to the release function once it is this caller's turn */
function acquireIntakeLock() {
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    const before = intakeTail;
    intakeTail = before.then(() => mine);
    return before.then(() => release);
}

// --- Is Lightning worth offering right now? ---------------------------------------
//
// The page defaults to Lightning when it is offered. Offering it while the treasury can
// barely cover an order, or while phoenixd is down, would turn most customers away at
// intake and send them back to on-chain — worse than not offering it. So the page is only
// told "yes" when a typical order would actually be accepted: phoenixd answers, and the
// treasury has room for a 200-byte text at the floor rate. Bigger orders are still decided
// one by one at intake.
const OFFER_PROBE_BYTES = 200;
const OFFER_CACHE_MS = 30 * 1000;
let offerCache = null;     // { at, offered }
let offerRefresh = null;   // the one refresh in flight, shared by every caller

async function computeOffered(db, rootNode, config) {
    let offered = false;
    try {
        const info = await getInfo(config);
        if (info.ok) {
            const probe = quote({ messageBytes: OFFER_PROBE_BYTES, targetAddress: null, feeRate: config.MIN_FEE_RATE, amountToSend: 0 }, config);
            offered = (await canFund(db, rootNode, config, probe.treasuryCost)).ok;
        }
    } catch (e) {
        console.warn(`[Lightning] Could not decide whether to offer Lightning: ${e.message}`);
    }
    offerCache = { at: Date.now(), offered };
    return offered;
}

/**
 * Whether to offer Lightning — answered from memory, never by waiting on the network.
 *
 * Asked on every homepage load (/api/config/limits), so it must not put phoenixd or three
 * block explorers in front of the page. The cached answer is returned immediately; when it
 * is older than OFFER_CACHE_MS one refresh starts in the background, shared by everyone
 * who asks meanwhile. With no answer yet, the answer is "no" — the page then offers
 * on-chain, which is always safe.
 */
async function isOffered(db, rootNode, config) {
    if (!config.LIGHTNING_ENABLED) return false;
    const fresh = offerCache && Date.now() - offerCache.at < OFFER_CACHE_MS;
    if (!fresh && !offerRefresh) {
        offerRefresh = computeOffered(db, rootNode, config).finally(() => { offerRefresh = null; });
    }
    return offerCache ? offerCache.offered : false;
}

/** The same decision, waited for. For tests and for the admin view, never for a page load. */
async function isOfferedNow(db, rootNode, config) {
    if (!config.LIGHTNING_ENABLED) return false;
    if (offerRefresh) await offerRefresh;
    return computeOffered(db, rootNode, config);
}

function invalidateOfferCache() {
    offerCache = null;
}

// --- Payment ----------------------------------------------------------------

const lastStatusCheck = new Map(); // request id -> epoch ms

function lightningPaymentRef(paymentHash) {
    return `${LN_TX_PREFIX}${paymentHash}`;
}

/**
 * Records a settled invoice against its row. Idempotent: the `paymentTxId IS NULL` guard
 * means exactly one caller — webhook, status poll or reconcile — ever wins, and only the
 * winner notifies and fulfils.
 *
 * An ARCHIVED row is still recorded. Its money is real: a customer can cancel and then
 * pay a code they already scanned. The row keeps its archived status, so no automatic
 * pass publishes a withdrawn message, and failureReason says what happened so the alert
 * and the customer's refund form both find it.
 *
 * @returns {Promise<boolean>} true when this call recorded the payment
 */
async function recordPayment(db, row, payment, config) {
    const paidSats = Number(payment.requestedSat ?? payment.receivedSat);
    const archived = !!row.archivedAt;
    const now = new Date().toISOString();
    const claim = await dbRun(
        db,
        `UPDATE requests
         SET paymentTxId = ?, paymentReceivedSatoshis = ?, paymentConfirmationCount = 1,
             paymentConfirmedAt = ?,
             status = CASE WHEN archivedAt IS NULL AND status = 'pending_payment' THEN 'payment_confirmed' ELSE status END,
             failureReason = CASE WHEN archivedAt IS NOT NULL THEN ? ELSE failureReason END
         WHERE id = ? AND paymentTxId IS NULL AND lnPaymentHash = ?`,
        [
            lightningPaymentRef(row.lnPaymentHash), paidSats, now,
            `lightning_paid_after_withdrawal: ${paidSats} sats arrived after the order was ${row.archivedReason || 'archived'}`,
            row.id, row.lnPaymentHash,
        ]
    );
    if (claim.changes !== 1) return false;

    const feeSats = Math.floor((Number(payment.fees) || 0) / 1000);
    events.record(db, row.id, events.KINDS.LIGHTNING_PAID,
        `${paidSats} sats over Lightning${feeSats ? ` (phoenixd kept ${feeSats} sats for liquidity)` : ''}${archived ? ' — AFTER the order was archived' : ''}`);
    console.log(`[Lightning] Payment recorded for ${row.id}: ${paidSats} sats${archived ? ' (archived order)' : ''}.`);

    if (archived) {
        notifier.notifyArchiveFunded({
            requestId: row.id,
            address: 'Lightning invoice',
            amount: paidSats,
            refundAddress: 'the customer will be asked for a Lightning address',
            createdAt: row.createdAt,
        }, config);
    } else {
        notifier.notifyPaymentReceived({
            requestId: row.id, amount: paidSats, message: row.message, payloadKind: row.payloadKind,
        }, config);
    }
    return true;
}

/**
 * Marks an unpaid, expired invoice's order dead. Only after EXPIRY_GRACE_MS past expiry,
 * and only with every money guard, so a payment that settled meanwhile wins.
 */
async function archiveExpired(db, row) {
    const claim = await dbRun(
        db,
        `UPDATE requests SET archivedAt = ?, archivedReason = 'lightning_invoice_expired'
         WHERE id = ? AND status = 'pending_payment' AND archivedAt IS NULL
           AND paymentTxId IS NULL AND paymentReceivedSatoshis IS NULL
           AND opReturnTxId IS NULL AND refundTxId IS NULL`,
        [new Date().toISOString(), row.id]
    );
    if (claim.changes === 1) {
        events.record(db, row.id, events.KINDS.LIGHTNING_EXPIRED, 'invoice expired unpaid');
        console.log(`[Lightning] Invoice for ${row.id} expired unpaid; order archived.`);
        return true;
    }
    return false;
}

/**
 * Looks the row's invoice up in phoenixd and acts on what phoenixd says — never on what a
 * caller says.
 *
 * `onPaid(freshRow)` is called once, by whichever caller actually recorded the payment,
 * for an order that is not archived. The caller passes fulfillRequest; this module does
 * not require request_service.js, which requires it.
 *
 * @returns {Promise<{ok: boolean, state?: 'paid'|'unpaid'|'expired'|'unknown', recorded?: boolean, reason?: string}>}
 */
async function checkInvoice(db, row, config, { onPaid } = {}) {
    if (!isLightningRow(row) || !row.lnPaymentHash) return { ok: false, reason: 'not a lightning order' };
    if (row.paymentTxId) return { ok: true, state: 'paid', recorded: false };

    const looked = await getIncomingPayment(config, row.lnPaymentHash);
    if (!looked.ok) return { ok: false, reason: looked.reason };
    if (!looked.found) return { ok: true, state: 'unknown' };

    const p = looked.payment;
    // Bound to its row twice over: phoenixd's own hash must be the one we stored, and the
    // invoice must carry this request's id. A payment for some other invoice can never be
    // credited here, whatever route the lookup came through.
    if (String(p.paymentHash) !== row.lnPaymentHash || String(p.externalId || '') !== row.id) {
        console.warn(`[Lightning] Invoice ${row.lnPaymentHash} does not belong to ${row.id} (externalId ${p.externalId}). Ignored.`);
        return { ok: false, reason: 'invoice does not belong to this order' };
    }

    if (p.isPaid === true) {
        const requested = Number(p.requestedSat ?? 0);
        if (requested < row.requiredAmountSatoshis) {
            // A fixed-amount invoice cannot be underpaid, so this means the invoice is not
            // the one we quoted. Recorded nowhere, reported loudly.
            console.error(`[Lightning] ${row.id}: paid invoice is for ${requested} sats but the order costs ${row.requiredAmountSatoshis}. NOT recorded — needs a human.`);
            return { ok: false, reason: 'invoice amount does not match the order' };
        }
        const recorded = await recordPayment(db, row, p, config);
        if (recorded && !row.archivedAt && typeof onPaid === 'function') {
            const fresh = await dbGet(db, 'SELECT * FROM requests WHERE id = ?', [row.id]);
            if (fresh && fresh.status === 'payment_confirmed') {
                Promise.resolve(onPaid(fresh)).catch((e) =>
                    console.error(`[Lightning] Fulfilment after payment threw for ${row.id}: ${e.message}`));
            }
        }
        return { ok: true, state: 'paid', recorded };
    }

    const expiresAt = Number(p.expiresAt) || Date.parse(row.lnInvoiceExpiresAt || '') || 0;
    if (p.isExpired === true && expiresAt && Date.now() > expiresAt + EXPIRY_GRACE_MS) {
        if (!row.archivedAt) await archiveExpired(db, row);
        return { ok: true, state: 'expired' };
    }
    return { ok: true, state: 'unpaid' };
}

/** checkInvoice on behalf of a customer's status poll, at most once per few seconds per order. */
async function checkInvoiceThrottled(db, row, config, opts) {
    const now = Date.now();
    if (now - (lastStatusCheck.get(row.id) || 0) < STATUS_CHECK_MIN_INTERVAL_MS) return { ok: true, state: 'throttled' };
    lastStatusCheck.set(row.id, now);
    if (lastStatusCheck.size > 5000) {
        for (const [id, at] of lastStatusCheck) if (now - at > 60 * 1000) lastStatusCheck.delete(id);
    }
    return checkInvoice(db, row, config, opts);
}

/**
 * The reconcile pass's half: every Lightning invoice that could still be paid, or was
 * paid without anyone noticing. A webhook that never arrived and a customer who closed
 * the tab both end here, within one reconcile interval.
 *
 * Archived rows are included until a day after their invoice expired: a cancelled order's
 * invoice stays payable until it expires, and money that arrives on one must be seen.
 */
async function pollOpenInvoices(db, config, { onPaid } = {}) {
    // LIGHTNING_CONFIGURED, not LIGHTNING_ENABLED. The kill switch stops NEW orders; an
    // invoice issued before it was thrown stays payable for half an hour, and that money
    // has to be seen. Gating this on the switch is how a payment would sit unrecorded until
    // cleanup archived its row as "abandoned, never paid".
    if (!config.LIGHTNING_CONFIGURED) return { checked: 0, paid: 0, expired: 0 };
    const rows = await dbAll(
        db,
        `SELECT * FROM requests
         WHERE paymentMethod = 'lightning'
           AND paymentTxId IS NULL
           AND lnPaymentHash IS NOT NULL
           AND lnInvoiceExpiresAt > ?
         ORDER BY createdAt ASC`,
        [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]
    );
    let paid = 0, expired = 0;
    for (const row of rows) {
        const result = await checkInvoice(db, row, config, { onPaid });
        if (result.recorded) paid++;
        if (result.state === 'expired') expired++;
        if (!result.ok && result.reason && !/does not belong|does not match/.test(result.reason)) {
            console.warn(`[Lightning] Could not check the invoice for ${row.id}: ${result.reason}`);
        }
    }
    return { checked: rows.length, paid, expired };
}

// --- Publishing -------------------------------------------------------------

/**
 * Settles a treasury transaction that was signed and recorded on the row by an earlier
 * attempt, before anything new is built. Only reached when this process has no memory of
 * those bytes (a restart, or the 12-hour ledger TTL): otherwise treasury.js re-sends them
 * itself and keeps its ledger straight.
 *
 * The same bytes are re-sent first: a node that has them answers "already known" (or
 * "already in utxo set" once confirmed), which is success. Any other answer is checked
 * with chainProviders.signedTxFate before anything is decided:
 *
 *   exists                      → published.
 *   dead (an input confirmed
 *         in another transaction) → it can never confirm: rebuild.
 *   refused by every host,
 *         none silent           → it is in no mempool: a definite rejection.
 *   anything else               → keep the bytes and ask again next pass
 *                                 (treasury_tx_unresolved / broadcast_unavailable).
 *
 * NEVER getTxStatus: Esplora reports a txid that does not exist as "unconfirmed", which
 * once recorded a message nobody broadcast as delivered. And never "the explorers do not
 * have it" as proof of absence: broadcasts go to BlockCypher first, and one host's mempool
 * can lack what another holds.
 *
 * Runs under the treasury's lock, so no fresh spend can choose the same inputs while this
 * is deciding what they are.
 */
async function resolvePendingTransaction(request, rootNode, config) {
    return treasury.withTreasuryLock(async () => {
        const txId = request.pendingTxId;
        const treasuryAddress = treasury.getTreasuryAddress(rootNode, config.NETWORK);
        const published = (extra = {}) => ({
            ok: true, opReturnTxId: txId, signedTxHex: request.pendingTxHex, changePath: treasury.TREASURY_PATH, ...extra,
        });

        const again = await chainProviders.broadcastTransaction(request.pendingTxHex, config, txId);
        if (again.ok) {
            console.log(`[Lightning] ${request.id}: re-sent its signed treasury transaction ${txId}${again.alreadyBroadcast ? ' (already known)' : ''}.`);
            treasury.noteBroadcast(request.pendingTxHex, treasuryAddress, config.NETWORK);
            return published({ alreadyBroadcast: !!again.alreadyBroadcast });
        }

        const fate = await chainProviders.signedTxFate(request.pendingTxHex, config);
        if (fate.state === 'exists') {
            console.log(`[Lightning] ${request.id}: its signed treasury transaction ${txId} is already on the network${fate.confirmed ? ' (confirmed)' : ''}.`);
            // A confirmed transaction is in every provider's view already. An unconfirmed
            // one may not be indexed everywhere, so the ledger learns its inputs are gone.
            if (!fate.confirmed) treasury.noteBroadcast(request.pendingTxHex, treasuryAddress, config.NETWORK);
            return published({ alreadyBroadcast: true });
        }
        if (fate.state === 'dead') {
            return {
                ok: false,
                reason: 'treasury_inputs_stale',
                detail: `${txId} was signed for this order but conflicts with confirmed ${fate.conflict}; it can never confirm and will be rebuilt`,
                permanent: false,
                clearPending: true,
            };
        }
        if (again.permanent && !again.inputsSpent && !chainProviders.mayHaveBeenAccepted(again)) {
            // Every host answered, and every answer was no: it is in no mempool, so nothing
            // was published and the slate is clean.
            return { ok: false, reason: 'broadcast_rejected', detail: `${again.reason} (re-sending ${txId})`, permanent: true, clearPending: true };
        }
        return {
            ok: false,
            reason: again.inputsSpent ? 'treasury_tx_unresolved' : 'broadcast_unavailable',
            detail: `${again.reason} re-sending ${txId}; whether it is on chain is not settled yet (${fate.reason}). `
                + 'The same bytes will be re-sent and checked again; nothing new is built until the chain decides.',
            permanent: false,
            clearPending: false,
        };
    });
}

// Request ids this process is publishing right now. The database lock (status
// processing_op_return) is released by reconcile.js after 30 minutes on the assumption that
// the worker died; one that is merely queued behind the treasury lock during an outage is
// still alive, and two live workers for one order would build two transactions. Memory is
// the right scope: every worker is in this process.
const fulfilling = new Set();

/**
 * Publishes a paid Lightning order out of the treasury. Returns the shape
 * op_return_creator.js returns, so request_service.js records either identically.
 */
async function fulfilLightning(request, db, rootNode, config) {
    // The treasury pays for whatever reaches this point, so "paid" is checked here and
    // not only by the callers. An on-chain order that was never paid fails by itself —
    // there is no UTXO to spend — but the treasury always has one, and an operator's
    // "fulfil" button on an unpaid Lightning order would otherwise publish it for free.
    if (!request.paymentTxId || !isLightningRef(request.paymentTxId)) {
        return { ok: false, reason: 'missing_payment_details', detail: `request ${request.id} has no recorded Lightning payment`, permanent: true };
    }
    if (fulfilling.has(request.id)) {
        return { ok: false, reason: 'fulfilment_in_progress', detail: `another worker in this process is already publishing ${request.id}`, permanent: false };
    }
    fulfilling.add(request.id);
    try {
        return await fulfilOnce(request, db, rootNode, config);
    } finally {
        fulfilling.delete(request.id);
    }
}

async function fulfilOnce(request, db, rootNode, config) {
    // 1. Bytes signed by an earlier process, and this process has no memory of them.
    if (request.pendingTxId && request.pendingTxHex && !treasury.hasAttemptedSpend(request.id)) {
        const resolved = await resolvePendingTransaction(request, rootNode, config);
        invalidateTreasuryCache();
        if (resolved.ok || !resolved.clearPending) return resolved;
        await dbRun(db, 'UPDATE requests SET pendingTxId = NULL, pendingTxHex = NULL WHERE id = ? AND opReturnTxId IS NULL', [request.id]);
        if (resolved.reason !== 'treasury_inputs_stale') return resolved;
        // Double-spent away and provably on no host: fall through and build afresh.
    }

    // 2. Build (or, within this process, re-send) through the treasury.
    let recipientValue;
    try {
        recipientValue = treasuryRecipientValue(request, config);
    } catch (e) {
        return { ok: false, reason: 'invalid_target_address', detail: `${request.targetAddress}: ${e.message}`, permanent: true };
    }
    const spendRequest = {
        id: request.id,
        message: request.message,
        payloadKind: request.payloadKind,
        targetAddress: recipientValue > 0 ? request.targetAddress : null,
        feeRate: request.feeRate,
        amountToSend: recipientValue,
    };
    const onSigned = async ({ txId, txHex }) => {
        // Only while this worker still holds the order. A refund that took the row, a
        // lock reconcile released, or a publication someone else recorded all change the
        // status, and then this transaction must not go out.
        const write = await dbRun(
            db,
            `UPDATE requests SET pendingTxId = ?, pendingTxHex = ?
             WHERE id = ? AND status = 'processing_op_return'
               AND opReturnTxId IS NULL AND refundTxId IS NULL`,
            [txId, txHex, request.id]
        );
        if (write.changes !== 1) throw new Error('the order changed state before its transaction could be recorded');
        events.record(db, request.id, events.KINDS.TREASURY_SIGNED, `signed ${txId}, broadcasting`);
    };

    // A stale view of our own wallet costs one round-trip, not an attempt. When
    // treasury.js answers `treasury_inputs_stale` it either holds no bytes for this order
    // (every host refused them: they entered no mempool) or it still holds them, because a
    // host might have taken them — and then the next call goes through its re-send path,
    // which asks the chain (signedTxFate) before anything new is built. Bounded, because
    // each try talks to the providers.
    let result;
    for (let tries = 0; tries < 3; tries++) {
        result = await treasury.createSelfFundedOpReturn(spendRequest, rootNode, config, { onSigned });
        if (result.ok || result.reason !== 'treasury_inputs_stale') break;
    }
    invalidateTreasuryCache();

    if (result.ok) {
        return { ok: true, opReturnTxId: result.txId, signedTxHex: result.txHex, changePath: result.changePath, alreadyBroadcast: result.alreadyBroadcast };
    }
    // Forget the recorded bytes only when they provably never entered a mempool: refused on
    // their merits by every host, or double-spent away — and only when the treasury is not
    // still holding them as possibly accepted. Everything else (a timeout, a fee rejection,
    // an unresolved re-send) keeps the record, because after a restart it is what gets
    // checked and re-sent.
    if ((result.reason === 'broadcast_rejected' || result.reason === 'treasury_inputs_stale')
        && !treasury.hasAttemptedSpend(request.id)) {
        await dbRun(db, 'UPDATE requests SET pendingTxId = NULL, pendingTxHex = NULL WHERE id = ? AND opReturnTxId IS NULL', [request.id]);
    }
    return { ok: false, reason: result.reason, detail: result.detail, permanent: !!result.permanent };
}

// --- Refunds ----------------------------------------------------------------

// Refund failures the customer can fix by giving us a different address. Anything else
// stays with the operator.
const RETRYABLE_REFUND_PREFIXES = ['ln_refund_failed', 'ln_no_refund_address'];

/**
 * Where a Lightning order stands on the way to a refund — the one question the customer's
 * page and the refund endpoint both ask, answered in one place.
 *
 *   null              not a refund case (not Lightning, not paid, delivered, or still
 *                     being retried)
 *   'needs_address'   failed for good; give us a Lightning address
 *   'retry_address'   our last attempt to pay the address failed; try another
 *   'in_progress'     paying now
 *   'refunded'        done
 *   'manual'          an outcome only the operator can settle
 */
function refundState(row, config = appConfig) {
    if (!isLightningRow(row) || !row.paymentTxId || row.opReturnTxId) return null;
    if (row.refundTxId) return 'refunded';
    if (row.status === 'refund_processing') return 'in_progress';
    if (row.pendingTxId) return 'manual';
    if (row.status === 'refund_failed') {
        return RETRYABLE_REFUND_PREFIXES.some((p) => String(row.refundFailureReason || '').startsWith(p))
            ? 'retry_address' : 'manual';
    }
    // Archived and paid — withdrawn before the payment landed, or settled by the operator
    // as "dropped" after it was withdrawn: no automatic pass publishes an archived order, so
    // the money goes back.
    if (row.archivedAt && (row.status === 'pending_payment' || row.status === 'op_return_failed')) return 'needs_address';
    if (row.status === 'op_return_failed') {
        if (isNoRefundReason(row.failureReason)) return 'manual';
        const exhausted = (row.attemptCount || 0) >= (config.MAX_FULFILL_ATTEMPTS || 3);
        if (exhausted || isPermanentReason(row.failureReason)) return 'needs_address';
    }
    return null;
}

/** Statuses a customer-initiated Lightning refund may start from. */
function customerRefundStatuses(row) {
    return row.archivedAt ? ['pending_payment', 'op_return_failed', 'refund_failed'] : ['op_return_failed', 'refund_failed'];
}

async function markLightningRefundFailed(db, requestId, reason) {
    await dbRun(
        db,
        "UPDATE requests SET status = 'refund_failed', refundFailureReason = ? WHERE id = ? AND refundTxId IS NULL",
        [reason, requestId]
    );
    events.record(db, requestId, events.KINDS.REFUND_FAILED, reason);
    console.error(`[Lightning] Refund for ${requestId} failed: ${reason}`);
    return { ok: false, reason };
}

/**
 * Pays a terminally failed Lightning order back to the Lightning address its customer
 * gave us. Called from refund.js attemptRefund, which every refund path goes through.
 *
 * At most once, by construction:
 *   - the conditional UPDATE to refund_processing is the lock, as in refund.js;
 *   - an outcome phoenixd could not report is recorded as refund_failed with a reason no
 *     automatic path retries and the customer cannot override — a human checks phoenixd's
 *     outgoing payments first;
 *   - reconcile.js never releases a Lightning refund lock back into a refundable state.
 */
async function attemptLightningRefund(request, db, config, options = {}) {
    const requestId = request.id;
    const allowed = options.allowStatuses || ['op_return_failed', 'refund_failed'];

    if (!config.REFUND_ENABLED && !options.force) return { ok: false, reason: 'refunds_disabled' };
    // Configured, not enabled: the kill switch stops new orders, never the way money goes back.
    if (!config.LIGHTNING_CONFIGURED) return { ok: false, reason: 'lightning_not_configured' };
    if (request.opReturnTxId) return { ok: false, reason: 'already_fulfilled' };
    if (request.refundTxId) return { ok: false, reason: 'already_refunded' };
    if (!request.paymentTxId || !request.paymentReceivedSatoshis) return { ok: false, reason: 'not_paid' };
    if (!allowed.includes(request.status)) return { ok: false, reason: `not_refundable_from_status_${request.status}` };
    // A signed treasury transaction we cannot account for may already have published the
    // message. Refunding as well would give the money back for something delivered.
    if (request.pendingTxId) return { ok: false, reason: 'publication_unresolved' };
    if (!request.lnRefundAddress) {
        // Not a failure of the refund — we are waiting on the customer. The status is left
        // where it is, so the customer's page keeps offering the address form.
        return { ok: false, reason: 'awaiting_lightning_refund_address' };
    }

    const lock = await dbRun(
        db,
        `UPDATE requests SET status = 'refund_processing', lastAttemptAt = ?
         WHERE id = ? AND refundTxId IS NULL AND opReturnTxId IS NULL AND pendingTxId IS NULL
           AND status IN (${allowed.map(() => '?').join(',')})`,
        [new Date().toISOString(), requestId, ...allowed]
    );
    if (lock.changes === 0) return { ok: false, reason: 'refund_lock_not_acquired' };

    const amount = request.paymentReceivedSatoshis;

    // Before any money moves, and inside the lock so nothing else can pay meanwhile.
    const host = await checkAddressHost(request.lnRefundAddress);
    if (!host.ok) {
        return markLightningRefundFailed(db, requestId, `ln_refund_failed: ${host.reason}`);
    }

    console.log(`[Lightning] Refunding ${amount} sats for ${requestId} to ${request.lnRefundAddress}`);
    events.record(db, requestId, events.KINDS.REFUND_STARTED, `${amount} sats to ${request.lnRefundAddress} over Lightning`);

    let paid;
    try {
        paid = await payLightningAddress(config, {
            address: request.lnRefundAddress,
            amountSat: amount,
            message: `SatWire refund ${String(requestId).slice(0, 8)}`,
        });
    } catch (e) {
        paid = { outcome: 'unknown', reason: e.message };
    }

    if (paid.outcome === 'sent') {
        const refundTxId = lightningPaymentRef(paid.paymentHash);
        await dbRun(
            db,
            "UPDATE requests SET status = 'refunded', refundTxId = ?, refundedAt = ?, refundFailureReason = NULL WHERE id = ?",
            [refundTxId, new Date().toISOString(), requestId]
        );
        events.record(db, requestId, events.KINDS.REFUNDED,
            `${paid.recipientAmountSat} sats to ${request.lnRefundAddress} over Lightning (routing fee ${paid.routingFeeSat}), payment ${paid.paymentHash}`);
        notifier.notifyRefunded({
            requestId, amount: paid.recipientAmountSat, refundTxId, refundAddress: request.lnRefundAddress,
        }, config);
        return { ok: true, refundTxId, amount: paid.recipientAmountSat };
    }
    if (paid.outcome === 'failed') {
        const kind = classifyRefundFailure(paid.reason);
        if (kind === 'customer') {
            return markLightningRefundFailed(db, requestId, `ln_refund_failed: ${paid.reason}`);
        }
        const reason = kind === 'node'
            ? `ln_refund_node_not_ready: ${paid.reason} — refund from the admin panel once phoenixd can pay`
            : `ln_refund_outcome_unknown: ${paid.reason} — check phoenixd's outgoing payments before refunding again`;
        notifier.notifyLightningRefundStuck({ requestId, amount, address: request.lnRefundAddress, reason }, config);
        return markLightningRefundFailed(db, requestId, reason);
    }
    const reason = `ln_refund_outcome_unknown: ${paid.reason} — check phoenixd's outgoing payments before refunding again`;
    notifier.notifyLightningRefundStuck({ requestId, amount, address: request.lnRefundAddress, reason }, config);
    return markLightningRefundFailed(db, requestId, reason);
}

/**
 * Whose problem a DEFINITE refund failure is. phoenixd reports lightning-kmp's own
 * wording (OutgoingPaymentFailure.kt), and three different people have to act on it:
 *
 *   'customer'  the address, or the route to it: the customer can check it or try another.
 *   'node'      our node could not pay at all — no spendable balance yet (early payments
 *               go to fee credit), or a channel still opening or closing. Another address
 *               would fail the same way, so asking the customer for one would be a lie.
 *   'unknown'   phoenixd says the invoice is already paid or a payment is already in
 *               flight. Money may have moved; a human checks before anything is retried.
 */
function classifyRefundFailure(reason) {
    const r = String(reason || '').toLowerCase();
    if (/already been paid|already in progress|another payment is in progress/.test(r)) return 'unknown';
    if (/not enough funds|insufficient|channel is not connected|channel creation is in progress|channel closing|wallet restarted/.test(r)) return 'node';
    return 'customer';
}

module.exports = {
    LIGHTNING,
    LN_TX_PREFIX,
    EXPIRY_GRACE_MS,
    isLightningRow,
    isLightningRef,
    lightningPaymentRef,
    // phoenixd
    createInvoice,
    getIncomingPayment,
    getBalance,
    getInfo,
    payLightningAddress,
    sendToAddress,
    verifyWebhookSignature,
    // addresses and pricing
    normalizeLightningAddress,
    isPrivateAddress,
    checkAddressHost,
    // Test hook: the harness resolves its made-up domains without real DNS.
    __setDnsLookup: (fn) => { dnsLookup = fn; },
    treasuryRecipientValue,
    quote,
    rowTreasuryCost,
    // treasury capacity, and whether to offer Lightning at all
    canFund,
    isOffered,
    isOfferedNow,
    invalidateOfferCache,
    acquireIntakeLock,
    classifyRefundFailure,
    treasurySpendable,
    treasuryReserved,
    invalidateTreasuryCache,
    // payment
    checkInvoice,
    checkInvoiceThrottled,
    pollOpenInvoices,
    // publishing and refunds
    fulfilLightning,
    resolvePendingTransaction,
    refundState,
    customerRefundStatuses,
    attemptLightningRefund,
};
