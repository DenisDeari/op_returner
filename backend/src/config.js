// backend/src/config.js
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const bitcoin = require('bitcoinjs-lib');

const { PORT, MNEMONIC, BLOCKCYPHER_TOKEN, WEBHOOK_RECEIVER_BASE_URL, ADMIN_PASSWORD } = process.env;

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

const NETWORK = bitcoin.networks.bitcoin; // Or bitcoin.networks.testnet
const NETWORK_NAME = NETWORK === bitcoin.networks.bitcoin ? 'main' : 'test3';

module.exports = {
    PORT: PORT || 3000,
    ADMIN_PASSWORD,
    MNEMONIC,
    BLOCKCYPHER_TOKEN,
    WEBHOOK_RECEIVER_BASE_URL,
    NETWORK,
    NETWORK_NAME,
    BLOCKCYPHER_API_BASE: `https://api.blockcypher.com/v1/btc/${NETWORK_NAME}`,
};
