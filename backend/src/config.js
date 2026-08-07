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

// Taproot support.
//
// bitcoinjs routes a bech32m v1 address through payments.p2tr(), which refuses to decode
// one until an ECC backend is registered. Without this, `toOutputScript` THROWS on a
// perfectly valid `bc1p…` address, and intake reports it as "not a valid Bitcoin address
// for this network" — so a customer paying to Taproot was turned away, and a Taproot payer
// could not be auto-refunded either. It failed closed, so no money was ever at risk, but
// it turned away legitimate business.
//
// Registered here because every module on a money path requires config, so there is no
// import order in which a Taproot address can reach toOutputScript before the backend
// exists. wallet_scan.js keeps its own lazy call; initEccLib is idempotent.
bitcoin.initEccLib(require('tiny-secp256k1'));

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

// Request retention.
//
// Requests are archived, never deleted: a row is the only record of what a customer
// asked for and where their money would go, and losing it destroys the ability to
// attribute a late payment to an address. `archivedAt` marks a row dead; `status` is
// deliberately left alone, because it is the behavioural signal worth keeping.
//
// The two deadlines are separate on purpose. Webhooks are retired first, because holding
// two BlockCypher hooks open per abandoned order costs a quota the money paths need.
// Archiving happens later, and only after one final chain check: an address that turns
// out to hold money is NOT archived — it is recorded and reported, for a human to decide.
// Between the two deadlines nothing is watching the address automatically, but the
// customer's own status polling still does its own chain check, and the archive-time
// check is the backstop.
const WEBHOOK_RETIRE_AFTER_MS = 62 * 60 * 60 * 1000;   // 62 hours
const REQUEST_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Long-horizon redaction of archived orders that were never paid.
//
// The ROW is never removed — it carries the index-to-address mapping that keeps a late
// payment attributable, and the UNIQUE constraints that stop an index being re-issued.
// Only the content is dropped: the customer's message, anything they wrote to us, and
// the address they wanted paid. Everything a behavioural question needs survives —
// when it was made, what fee rate, what amount, how big the message was, how it died.
//
// Six months, because the point is to not hold a stranger's words forever, not to save
// space: 67 orders in nine months is nothing. A redaction is irreversible, so it is
// guarded exactly like an archive, including a fresh chain check — money can arrive at
// an address long after it was abandoned, and the message is the only record of what
// that money was for.
const REDACT_ARCHIVED_AFTER_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
const REDACTION_ENABLED = process.env.REDACTION_ENABLED !== 'false'; // opt-out, on by default

// Failure handling
const MAX_FULFILL_ATTEMPTS = 3;
const RECONCILE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const REFUND_ENABLED = process.env.REFUND_ENABLED !== 'false'; // opt-out, on by default

// Customer feedback on failed requests
const USER_FEEDBACK_MAX_BYTES = 1000;

// Intake throttling.
//
// Creating a request is not free: it burns a wallet index permanently (queue.js), writes
// a row, and registers two BlockCypher webhooks against a free-tier allowance the money
// paths depend on. The endpoint is public — `optionalApiKey` lets a caller through when
// no key is presented — and until now the 48-hour cleanup delete was the only thing
// bounding that table at all. Requests are archived rather than deleted now, so the only
// bound left is here.
//
// Sized against real behaviour rather than guessed: the heaviest genuine user so far made
// four orders in ninety minutes (2026-08-06), and a customer repricing a fee rate makes
// two within a minute. Ten an hour leaves generous headroom for both; the daily cap stops
// a slow drip from adding up. A caller presenting a valid API key is exempt.
const INTAKE_MAX_PER_HOUR = 10;
const INTAKE_MAX_PER_DAY = 40;

// Wallet view (read-only; nothing here can spend).
// A branch is scanned until this many consecutive never-used addresses are seen. 20 is
// the BIP44 convention and what Electrum and Sparrow use, so a scan here finds the same
// addresses they would.
const WALLET_GAP_LIMIT = 20;
// Hard ceiling per branch, so a pathological path cannot issue unbounded API calls.
const WALLET_MAX_SCAN_INDICES = 200;
// Balances are cached this long. Generous on purpose: a full scan touches well over a
// hundred addresses, so a short window meant the panel re-scanned on nearly every visit
// and spent 30s doing it. The panel shows when the figures were last checked and has a
// Refresh button that forces a fresh read, which is how a wallet app normally behaves.
const WALLET_CACHE_TTL_MS = 10 * 60 * 1000;
// Parallel address lookups. Kept deliberately low: blockstream.info starts returning 429
// at 8 parallel requests, and the same hosts serve the money paths, so tripping their
// limits here would hurt broadcasts too.
const WALLET_SCAN_CONCURRENCY = 4;
// Hard wall-clock budget for one whole scan. This runs inside an admin HTTP request, and
// when both Esplora hosts are struggling at once — one rate-limiting, the other timing
// out at the connection — a full scan can otherwise spend minutes failing. Past the
// budget the scan stops, falls back to the last known figures, and says it is incomplete.
const WALLET_SCAN_BUDGET_MS = 25 * 1000;
// An explicit Refresh gets longer. A healthy full re-read of every address takes about
// 28s, so the normal budget would cut it short and report "incomplete" every single time
// — training the operator to ignore a warning that is supposed to mean something. The
// operator pressed the button and is watching a spinner; the page-load path is the one
// that must stay quick, and it is served from the overview cache anyway.
const WALLET_REFRESH_BUDGET_MS = 60 * 1000;

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
    // Request retention
    WEBHOOK_RETIRE_AFTER_MS,
    REQUEST_ARCHIVE_AFTER_MS,
    REDACT_ARCHIVED_AFTER_MS,
    REDACTION_ENABLED,
    // Failure handling
    MAX_FULFILL_ATTEMPTS,
    RECONCILE_INTERVAL_MS,
    REFUND_ENABLED,
    // Customer feedback
    USER_FEEDBACK_MAX_BYTES,
    // Intake throttling
    INTAKE_MAX_PER_HOUR,
    INTAKE_MAX_PER_DAY,
    // Wallet view
    WALLET_GAP_LIMIT,
    WALLET_MAX_SCAN_INDICES,
    WALLET_CACHE_TTL_MS,
    WALLET_SCAN_CONCURRENCY,
    WALLET_SCAN_BUDGET_MS,
    WALLET_REFRESH_BUDGET_MS,
    // Telegram notifications
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    NOTIFY_ENABLED,
};
