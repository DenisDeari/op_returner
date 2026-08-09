// backend/src/treasury.js
// Self-funded OP_RETURN transactions using a dedicated treasury address.
// Uses a fixed derivation path (m/84'/0'/0'/2/0) separate from user request addresses.

const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const appConfig = require('./config');
const txSizing = require('./tx_sizing');

const bip32 = BIP32Factory(ecc);

// Dedicated treasury path — never overlaps with user request paths (m/84'/0'/0'/0/index)
const TREASURY_PATH = "m/84'/0'/0'/2/0";

/**
 * Derives the treasury P2WPKH address from the HD wallet root node.
 */
function getTreasuryAddress(rootNode, network) {
    const node = rootNode.derivePath(TREASURY_PATH);
    const pubkey = Buffer.from(node.publicKey);
    const { address } = bitcoin.payments.p2wpkh({ pubkey, network });
    return address;
}

/**
 * Fetches confirmed + unconfirmed UTXOs for the treasury address from BlockCypher.
 */
async function fetchTreasuryUtxos(address, config) {
    const url = `${config.BLOCKCYPHER_API_BASE}/addrs/${address}?unspentOnly=true&token=${config.BLOCKCYPHER_TOKEN}`;
    console.log(`[Treasury] Fetching UTXOs for ${address}...`);
    const response = await axios.get(url);
    const data = response.data;

    // BlockCypher returns confirmed refs in txrefs, unconfirmed in unconfirmed_txrefs
    const confirmed = (data.txrefs || []).filter(ref => !ref.spent);
    const unconfirmed = (data.unconfirmed_txrefs || []).filter(ref => !ref.spent);

    if (unconfirmed.length > 0) {
        console.warn(`[Treasury] ${unconfirmed.length} unconfirmed UTXO(s) found. Using confirmed only for safety.`);
    }

    console.log(`[Treasury] Found ${confirmed.length} confirmed UTXO(s). Balance: ${confirmed.reduce((s, u) => s + u.value, 0)} sats`);
    return confirmed;
}

/**
 * Creates and broadcasts a self-funded OP_RETURN transaction from the treasury address.
 * Change is returned to the treasury address.
 *
 * @param {string} message - UTF-8 message to embed
 * @param {string|null} targetAddress - Optional recipient address
 * @param {number|null} feeRate - sats/vByte (defaults to config.DEFAULT_FEE_RATE)
 * @param {number|null} amountToSend - Sats to send to targetAddress
 * @param {object} rootNode - BIP32 HD wallet root node
 * @param {object} config - App config
 * @returns {Promise<{txId, txHex, treasuryAddress, fee, inputValue, changeValue}>}
 */
async function createSelfFundedOpReturn(message, targetAddress, feeRate, amountToSend, rootNode, config) {
    const network = config.NETWORK;
    const treasuryAddress = getTreasuryAddress(rootNode, network);

    console.log(`[Treasury] Creating self-funded OP_RETURN. Treasury: ${treasuryAddress}`);

    // --- Fetch UTXOs ---
    const utxos = await fetchTreasuryUtxos(treasuryAddress, config);
    if (!utxos || utxos.length === 0) {
        throw new Error(`Treasury has no confirmed UTXOs. Please fund: ${treasuryAddress}`);
    }

    // Pick the largest UTXO for simplicity
    utxos.sort((a, b) => b.value - a.value);
    const utxo = utxos[0];
    const inputValue = utxo.value;

    // --- Estimate fees ---
    const opReturnBuffer = Buffer.from(message, 'utf8');
    const opReturnOutput = bitcoin.payments.embed({ data: [opReturnBuffer] });

    // Validate and size the recipient output before pricing anything, exactly as the
    // public path does: both the fee and the dust limit depend on its script type.
    let targetScript = null;
    if (targetAddress) {
        try {
            targetScript = bitcoin.address.toOutputScript(targetAddress, network);
        } catch (e) {
            throw new Error(`Invalid targetAddress for this network: ${e.message}`);
        }
    }

    // input + opreturn + change (P2WPKH) + overhead, plus the recipient output measured
    // from its own script — a flat 31 undercounts a P2WSH one by 12 vBytes.
    //
    // The OP_RETURN output comes from txSizing, the same function the quoting and building
    // paths use. This was `opReturnScriptLength + 9`, which assumes a one-byte script
    // varint and so under-counts by 2 vBytes for any script over 252 bytes. Unlike
    // op_return_creator.js there is no FEE_SAFETY_VBYTES here to absorb it, so the built
    // fee landed just under the requested rate — at the default rate of 2 that is a
    // transaction priced fractionally below the floor the whole service is built around.
    // Reachable today: max_payload_size is 1000.
    //
    // The overhead is 10.5, not 10: version(4) + input count(1) + output count(1) +
    // locktime(4), plus the segwit marker and flag, which are 2 witness bytes and so half
    // a vByte. Every other estimator in the service uses 10.5. FEE_SAFETY_VBYTES then
    // covers the rounding, exactly as in op_return_creator.js — without it this path was
    // the only one building with no headroom at all.
    const FEE_SAFETY_VBYTES = 4;
    let estimatedVBytes = 68 + txSizing.opReturnOutputVBytes(opReturnBuffer.length) + 31 + 10.5 + FEE_SAFETY_VBYTES;
    if (targetScript) estimatedVBytes += txSizing.outputVBytes(targetScript);
    estimatedVBytes = Math.ceil(estimatedVBytes);

    // Never build below the effective floor. A transaction sitting exactly on the minimum
    // relay fee is rejected as non-standard, which is why the floor is 2 and not 1 — and
    // this path had no floor at all, so a caller passing feeRate 1 produced a transaction
    // the network would refuse. The customer path has enforced this since 2026-08-06.
    const requestedFeeRate = feeRate || appConfig.DEFAULT_FEE_RATE;
    const effectiveFeeRate = Math.max(requestedFeeRate, appConfig.MIN_EFFECTIVE_FEE_RATE);
    if (effectiveFeeRate !== requestedFeeRate) {
        console.warn(`[Treasury] Raised fee rate ${requestedFeeRate} to the ${effectiveFeeRate} sat/vB floor.`);
    }
    const fee = estimatedVBytes * effectiveFeeRate;

    // A recipient output below the dust limit makes the transaction non-standard and it
    // is rejected at broadcast. Same failure mode as the public path — clamp it here too,
    // against the limit for this address type rather than a single constant.
    let targetValue = 0;
    if (targetScript && amountToSend && amountToSend > 0) {
        const recipientDustLimit = txSizing.dustLimitForScript(targetScript, appConfig);
        targetValue = Math.max(amountToSend, recipientDustLimit);
        if (targetValue !== amountToSend) {
            console.warn(`[Treasury] Raised sub-dust recipient amount ${amountToSend} to ${recipientDustLimit} (the dust limit for ${targetAddress}).`);
        }
    }

    const changeValue = inputValue - fee - targetValue;

    console.log(`[Treasury] Input: ${inputValue} | Fee: ${fee} | To recipient: ${targetValue} | Change: ${changeValue}`);

    if (changeValue < 0) {
        throw new Error(`Insufficient treasury funds. Have ${inputValue} sats, need at least ${fee + targetValue} sats (fee: ${fee}, recipient: ${targetValue}).`);
    }

    // --- Build PSBT ---
    const psbt = new bitcoin.Psbt({ network });

    // Derive P2WPKH scriptPubKey from the treasury address — no need to fetch from API
    const scriptPubKey = bitcoin.address.toOutputScript(treasuryAddress, network);

    psbt.addInput({
        hash: utxo.tx_hash,
        index: utxo.tx_output_n,
        witnessUtxo: {
            script: scriptPubKey,
            value: inputValue,
        },
    });

    // OP_RETURN output (value = 0)
    psbt.addOutput({ script: opReturnOutput.output, value: 0 });

    // Optional recipient output
    if (targetScript && targetValue > 0) {
        console.log(`[Treasury] Adding recipient output: ${targetValue} sats → ${targetAddress}`);
        psbt.addOutput({ script: targetScript, value: targetValue });
    }

    // Change back to treasury
    if (changeValue >= appConfig.DUST_LIMIT_SATS) {
        psbt.addOutput({ address: treasuryAddress, value: changeValue });
    } else {
        console.log(`[Treasury] Change (${changeValue}) below dust limit — absorbed into fee.`);
    }

    // --- Sign ---
    const treasuryNode = rootNode.derivePath(TREASURY_PATH);
    const customSigner = {
        publicKey: Buffer.from(treasuryNode.publicKey),
        network,
        sign: (hash) => Buffer.from(treasuryNode.sign(hash)),
        signSchnorr: (hash) => Buffer.from(treasuryNode.signSchnorr(hash)),
    };

    psbt.signInput(0, customSigner);
    psbt.finalizeAllInputs();

    const tx = psbt.extractTransaction();
    const txHex = tx.toHex();
    const txId = tx.getId();

    // Check the fee against the transaction that ACTUALLY got built, not the estimate.
    //
    // The estimate is made before signing and can only ever be approximate; this is the
    // real signed size. op_return_creator.js has had this check since the 2026-08-06 loss,
    // when two orders were priced below the relay minimum and only caught here. This path
    // never had it, so an under-estimate would have been discovered by the network instead
    // — as a silent non-propagating transaction that had already spent a treasury UTXO.
    const actualVBytes = tx.virtualSize();
    const actualFeeRate = fee / actualVBytes;
    if (actualFeeRate < appConfig.MIN_EFFECTIVE_FEE_RATE) {
        throw new Error(
            `Refusing to broadcast: computed fee ${fee} sats over ${actualVBytes} vBytes is `
            + `${actualFeeRate.toFixed(3)} sat/vB, below the ${appConfig.MIN_EFFECTIVE_FEE_RATE} sat/vB floor. `
            + `The size estimate (${estimatedVBytes} vBytes) was too low.`
        );
    }
    console.log(`[Treasury] Signed TX. ID: ${txId} (${actualVBytes} vBytes, ${fee} sats, ${actualFeeRate.toFixed(2)} sat/vB)`);

    // --- Broadcast ---
    const broadcastUrl = `${config.BLOCKCYPHER_API_BASE}/txs/push?token=${config.BLOCKCYPHER_TOKEN}`;
    try {
        const broadcastResponse = await axios.post(broadcastUrl, { tx: txHex });
        if (broadcastResponse.data && broadcastResponse.data.tx && broadcastResponse.data.tx.hash) {
            console.log(`[Treasury] Broadcast successful. TXID: ${broadcastResponse.data.tx.hash}`);
        } else {
            console.log(`[Treasury] Broadcast returned 2xx. TXID: ${txId}`);
        }
    } catch (err) {
        const errMsg = err.response?.data?.error || err.message;
        console.error(`[Treasury] Broadcast failed:`, errMsg);
        throw new Error(`Broadcast failed: ${errMsg}`);
    }

    return { txId, txHex, treasuryAddress, fee, inputValue, changeValue };
}

module.exports = { getTreasuryAddress, fetchTreasuryUtxos, createSelfFundedOpReturn };
