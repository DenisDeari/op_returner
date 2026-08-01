// backend/src/config.js
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const bitcoin = require('bitcoinjs-lib');

const {
    PORT, MNEMONIC, BLOCKCYPHER_TOKEN, WEBHOOK_RECEIVER_BASE_URL, ADMIN_PASSWORD, API_KEY, SUPPORT_EMAIL,
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
} = process.env;

// Basic validation
if (!MNEMONIC || MNEMONIC.split(' ').length < 12) {
    console.error("FATAL ERROR: MNEMONIC environment variable not found or is invalid.");
    process.exit(1);
}
if (!BLOCKCYPHER_TOKEN) {
    console.warn("WARNING: BLOCKCYPHER_TOKEN environment variable not found. Webhook registration will be skipped.");
}
if (!WEBHOOK_RECEIVER_BASE_URL) {
    console.error("FATAL ERROR: WEBHOOK_RECEIVER_BASE_URL environment variable not found.");
    process.exit(1);
}
if (!API_KEY) {
    console.warn("WARNING: API_KEY environment variable not set. API endpoints will reject all requests.");
}

const NETWORK = bitcoin.networks.bitcoin; // Or bitcoin.networks.testnet
const NETWORK_NAME = NETWORK === bitcoin.networks.bitcoin ? 'main' : 'test3';

// Fee and transaction constants
const SERVICE_FEE_SATS = 2000;
const DUST_LIMIT_SATS = 546;
const DEFAULT_FEE_RATE = 2; // sats per vByte

// Intake validation bounds.
// amountToSend must be either 0 (no recipient output) or at least DUST_LIMIT_SATS.
// Anything in between produces a non-standard "dust" output that relays reject —
// which previously happened *after* the customer had already paid.
// A transaction paying exactly 1 sat/vByte sits precisely on Bitcoin's minimum relay
// fee, and providers reject it as "non standard: low fee rate" — observed in production
// on 2026-08-01. Anything we build must clear that floor with room to spare, so the
// effective rate is never allowed below MIN_EFFECTIVE_FEE_RATE regardless of what the
// customer asked for. The difference comes out of the service fee, not the customer.
const MIN_FEE_RATE = 2;   // sats/vByte, lowest a customer may request
const MAX_FEE_RATE = 500; // sats/vByte
const MIN_EFFECTIVE_FEE_RATE = 2; // sats/vByte, hard floor applied when building
const MAX_AMOUNT_TO_SEND_SATS = 100_000_000; // 1 BTC sanity ceiling

// Failure handling
const MAX_FULFILL_ATTEMPTS = 3;
const RECONCILE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const REFUND_ENABLED = process.env.REFUND_ENABLED !== 'false'; // opt-out, on by default

// Customer feedback on failed requests
const USER_FEEDBACK_MAX_BYTES = 1000;

// Wallet view (read-only; nothing here can spend).
// A branch is scanned until this many consecutive never-used addresses are seen. 20 is
// the BIP44 convention and what Electrum and Sparrow use, so a scan here finds the same
// addresses they would.
const WALLET_GAP_LIMIT = 20;
// Hard ceiling per branch, so a pathological path cannot issue unbounded API calls.
const WALLET_MAX_SCAN_INDICES = 200;
// Balances are cached this long. A scan touches dozens of addresses and the panel gets
// refreshed often; without this every refresh would be a fresh burst of explorer calls.
const WALLET_CACHE_TTL_MS = 60 * 1000;
// Parallel address lookups. Kept deliberately low: blockstream.info starts returning 429
// at 8 parallel requests, and the same hosts serve the money paths, so tripping their
// limits here would hurt broadcasts too.
const WALLET_SCAN_CONCURRENCY = 4;

// Telegram notifications. Silently inactive unless both the token and chat id are set,
// so the service behaves exactly as before when they are absent.
const NOTIFY_ENABLED = process.env.NOTIFY_ENABLED !== 'false';
if (NOTIFY_ENABLED && (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)) {
    console.warn('WARNING: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set. Activity notifications are disabled.');
}

module.exports = {
    PORT: PORT || 3000,
    ADMIN_PASSWORD,
    API_KEY,
    MNEMONIC,
    BLOCKCYPHER_TOKEN,
    WEBHOOK_RECEIVER_BASE_URL,
    SUPPORT_EMAIL,
    NETWORK,
    NETWORK_NAME,
    BLOCKCYPHER_API_BASE: `https://api.blockcypher.com/v1/btc/${NETWORK_NAME}`,
    // Fee and transaction constants
    SERVICE_FEE_SATS,
    DUST_LIMIT_SATS,
    DEFAULT_FEE_RATE,
    // Intake validation bounds
    MIN_FEE_RATE,
    MAX_FEE_RATE,
    MIN_EFFECTIVE_FEE_RATE,
    MAX_AMOUNT_TO_SEND_SATS,
    // Failure handling
    MAX_FULFILL_ATTEMPTS,
    RECONCILE_INTERVAL_MS,
    REFUND_ENABLED,
    // Customer feedback
    USER_FEEDBACK_MAX_BYTES,
    // Wallet view
    WALLET_GAP_LIMIT,
    WALLET_MAX_SCAN_INDICES,
    WALLET_CACHE_TTL_MS,
    WALLET_SCAN_CONCURRENCY,
    // Telegram notifications
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    NOTIFY_ENABLED,
};
