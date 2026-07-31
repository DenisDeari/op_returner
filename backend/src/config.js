// backend/src/config.js
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const bitcoin = require('bitcoinjs-lib');

const { PORT, MNEMONIC, BLOCKCYPHER_TOKEN, WEBHOOK_RECEIVER_BASE_URL, ADMIN_PASSWORD, API_KEY, SUPPORT_EMAIL } = process.env;

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
const MIN_FEE_RATE = 1;   // sats/vByte
const MAX_FEE_RATE = 500; // sats/vByte
const MAX_AMOUNT_TO_SEND_SATS = 100_000_000; // 1 BTC sanity ceiling

// Failure handling
const MAX_FULFILL_ATTEMPTS = 3;
const RECONCILE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const REFUND_ENABLED = process.env.REFUND_ENABLED !== 'false'; // opt-out, on by default

// Customer feedback on failed requests
const USER_FEEDBACK_MAX_BYTES = 1000;

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
    MAX_AMOUNT_TO_SEND_SATS,
    // Failure handling
    MAX_FULFILL_ATTEMPTS,
    RECONCILE_INTERVAL_MS,
    REFUND_ENABLED,
    // Customer feedback
    USER_FEEDBACK_MAX_BYTES,
};
