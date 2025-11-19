// backend/src/op_return_creator.js

const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');

const bip32 = BIP32Factory(ecc);

async function findUtxoForAddress(txId, targetAddress, apiBase, token) {
    const apiUrl = `${apiBase}/txs/${txId}?token=${token}&includeScript=true`;
    console.log(`[OpReturnCreator] Fetching TX details from: ${apiUrl.split('?')[0]}...`); // Hide token

    try {
        const response = await axios.get(apiUrl);
        const txData = response.data;

        if (!txData || !txData.outputs || !Array.isArray(txData.outputs)) {
            console.error(`[OpReturnCreator] Invalid transaction data for txId ${txId}`);
            return null;
        }

        for (let i = 0; i < txData.outputs.length; i++) {
            const output = txData.outputs[i];
            if (output.addresses && output.addresses.includes(targetAddress)) {
                console.log(`[OpReturnCreator] Found UTXO for ${targetAddress} in tx ${txId}, vout ${i}, value ${output.value}`);
                return {
                    vout: i,
                    value: output.value,
                    script: output.script
                };
            }
        }
        console.error(`[OpReturnCreator] No output found for address ${targetAddress} in tx ${txId}`);
        return null;
    } catch (error) {
        console.error(`[OpReturnCreator] Error fetching transaction details for ${txId}:`, error.message);
        if (error.response) {
            console.error('API Error Status:', error.response.status);
            console.error('API Error Data:', error.response.data);
        }
        return null;
    }
}

async function broadcastTransaction(signedTxHex, apiBase, token) {
    const apiUrl = `${apiBase}/txs/push?token=${token}`;
    console.log(`[OpReturnCreator] Pushing TX to: ${apiUrl.split('?')[0]}...`); // Hide token
    try {
        const response = await axios.post(apiUrl, { tx: signedTxHex });
        if (response.data && response.data.tx && response.data.tx.hash) {
            console.log("[OpReturnCreator] Broadcast successful. TX Hash:", response.data.tx.hash);
            return true;
        } else {
            console.warn("[OpReturnCreator] Broadcast response structure unexpected, but received 2xx status:", response.data);
            return true;
        }
    } catch (error) {
        console.error(`[OpReturnCreator] Error pushing transaction:`, error.message);
        if (error.response) {
            console.error('API Error Status:', error.response.status);
            console.error('API Error Data:', error.response.data);
        }
        return false;
    }
}

async function createOpReturnTransaction(request, rootNode, network, config) {
    console.log(`[OpReturnCreator] Starting OP_RETURN creation for request ID: ${request?.id}`);
    if (!request || !config) {
        console.error("[OpReturnCreator] FATAL: Request or Config object is missing!");
        return null;
    }
    const { id, message, paymentTxId, paymentReceivedSatoshis, derivationPath, address: inputAddress } = request;
    const { BLOCKCYPHER_API_BASE, BLOCKCYPHER_TOKEN } = config;
    const coinType = network === bitcoin.networks.bitcoin ? 0 : 1;

    if (!message || Buffer.byteLength(message, 'utf8') > 80) {
        console.error(`[OpReturnCreator] Invalid message for request ${id}. Aborting.`);
        return null;
    }
    if (!paymentTxId || paymentReceivedSatoshis === undefined || !derivationPath || !inputAddress) {
        console.error(`[OpReturnCreator] Missing payment details in request ${id}. Aborting.`);
        return null;
    }

    try {
        const utxo = await findUtxoForAddress(paymentTxId, inputAddress, BLOCKCYPHER_API_BASE, BLOCKCYPHER_TOKEN);
        if (!utxo) {
            console.error(`[OpReturnCreator] Could not find suitable UTXO for ${inputAddress} in tx ${paymentTxId}.`);
            return null;
        }
        const inputValue = utxo.value;
        if (inputValue !== paymentReceivedSatoshis) {
            console.warn(`[OpReturnCreator] WARNING: Expected amount (${paymentReceivedSatoshis}) differs from found UTXO value (${inputValue}). Using actual.`);
        }

        const psbt = new bitcoin.Psbt({ network });
        const opReturnBuffer = Buffer.from(message, 'utf8');

        const opReturnScriptLength = bitcoin.payments.embed({ data: [opReturnBuffer] }).output.length;
        const estimatedVBytes = 68 + opReturnScriptLength + 31 + 10;
        const feeRateSatPerVByte = 2; // Consider making this dynamic
        const fee = estimatedVBytes * feeRateSatPerVByte;
        const changeValue = inputValue - fee;

        console.log(`[OpReturnCreator] Calculated fee: ${fee} sats for ${estimatedVBytes} vBytes. Change: ${changeValue}`);

        psbt.addInput({
            hash: paymentTxId,
            index: utxo.vout,
            witnessUtxo: {
                script: Buffer.from(utxo.script, 'hex'),
                value: inputValue,
            },
        });

        const opReturnOutput = bitcoin.payments.embed({ data: [opReturnBuffer] });
        psbt.addOutput({
            script: opReturnOutput.output,
            value: 0,
        });

        const DUST_LIMIT = 546;
        if (changeValue >= DUST_LIMIT) {
            const changePath = `m/84'/${coinType}'/0'/1/0`; // TODO: Increment change index
            let changeAddressNode;
            try {
                changeAddressNode = rootNode.derivePath(changePath);
                const changePubkeyBuffer = Buffer.from(changeAddressNode.publicKey);
                const { address: derivedChangeAddress } = bitcoin.payments.p2wpkh({ pubkey: changePubkeyBuffer, network: network });
                if (!derivedChangeAddress) throw new Error("Failed to derive change address string.");
                console.log(`[OpReturnCreator] Adding change output: ${changeValue} sats to ${derivedChangeAddress}`);
                psbt.addOutput({
                    address: derivedChangeAddress,
                    value: changeValue,
                });
            } catch (deriveError) {
                console.error(`[OpReturnCreator] FAILED to derive change address at ${changePath}:`, deriveError);
                return null;
            }
        } else {
            console.log(`[OpReturnCreator] Change ${changeValue} below dust limit. Not adding change output.`);
        }

        let inputKeyPair;
        try {
            inputKeyPair = rootNode.derivePath(derivationPath);
        } catch (deriveError) {
            console.error(`[OpReturnCreator] FAILED to derive input keypair at path ${derivationPath}:`, deriveError);
            return null;
        }

        const customSigner = {
            publicKey: Buffer.from(inputKeyPair.publicKey),
            network: network,
            sign: (hashToSign) => {
                try {
                    return Buffer.from(inputKeyPair.sign(hashToSign));
                } catch (signError) {
                    console.error("[OpReturnCreator] Error during inputKeyPair.sign:", signError);
                    throw signError;
                }
            },
            signSchnorr: (hashToSign) => Buffer.from(inputKeyPair.signSchnorr(hashToSign))
        };

        psbt.signInput(0, customSigner);

        const validator = (pubkey, msghash, signature) => {
            if (Buffer.compare(pubkey, Buffer.from(inputKeyPair.publicKey)) !== 0) {
                console.error("[OpReturnCreator] Validator: Provided pubkey doesn't match expected.");
                return false;
            }
            return inputKeyPair.verify(msghash, signature);
        };

        if (!psbt.validateSignaturesOfInput(0, validator)) {
            console.error("[OpReturnCreator] ERROR: Signature validation failed for input 0!");
            // return null; // Or handle as a critical error
        } else {
            console.log("[OpReturnCreator] Signatures validated successfully.");
        }

        psbt.finalizeAllInputs();
        const transaction = psbt.extractTransaction();
        const signedTxHex = transaction.toHex();
        const newTxId = transaction.getId();
        console.log(`[OpReturnCreator] Transaction signed and finalized. New TXID: ${newTxId}`);

        const broadcastSuccess = await broadcastTransaction(signedTxHex, BLOCKCYPHER_API_BASE, BLOCKCYPHER_TOKEN);

        if (broadcastSuccess && newTxId) {
            console.log(`[OpReturnCreator] Successfully broadcasted OP_RETURN TX: ${newTxId}`);
            return { opReturnTxId: newTxId, signedTxHex: signedTxHex }; // Return object
        } else {
            console.error(`[OpReturnCreator] Failed to broadcast transaction (TXID preview: ${newTxId}).`);
            return null;
        }

    } catch (error) {
        console.error(`[OpReturnCreator] CATCH BLOCK Error during OP_RETURN creation for request ${id}:`, error);
        return null;
    }
}

module.exports = {
    createOpReturnTransaction
};