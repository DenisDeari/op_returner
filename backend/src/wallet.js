// backend/src/wallet.js
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const config = require('./config');

const bip32 = BIP32Factory(ecc);

function initializeWallet() {
    try {
        if (!bip39.validateMnemonic(config.MNEMONIC)) {
            console.error("!!! MNEMONIC provided is NOT VALID. Please check it. !!!");
            process.exit(1);
        }
        const seed = bip39.mnemonicToSeedSync(config.MNEMONIC);
        const rootNode = bip32.fromSeed(seed);
        console.log("HD Wallet root node created successfully.");
        return rootNode;
    } catch (error) {
        console.error("FATAL ERROR: Failed to create HD wallet from mnemonic:", error);
        process.exit(1);
    }
}

module.exports = { initializeWallet };
