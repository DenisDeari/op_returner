// backend/src/op_return_creator.js

const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const appConfig = require('./config');
const chainProviders = require('./chain_providers');
const txSizing = require('./tx_sizing');
const payload = require('./payload');

const bip32 = BIP32Factory(ecc);

/**
 * The builder's last-resort ceiling on what may be embedded, in on-chain bytes.
 *
 * Not the policy limit — max_payload_size and max_image_payload_size are, and they are
 * enforced at intake before a payment address is quoted, which is the only place a limit
 * can protect a customer. This one only stops a row that reached the builder without
 * passing through intake.
 */
const MAX_ON_CHAIN_PAYLOAD_BYTES = 20000;

/**
 * Failure reasons that are inherent to the request itself. Retrying them unchanged
 * can never succeed, so the caller should stop retrying and move straight to a refund.
 */
const PERMANENT_FAILURES = new Set([
    'invalid_message',
    'missing_payment_details',
    'insufficient_payment',
    'invalid_target_address',
    'change_derivation_failed',
    'key_derivation_failed',
    'signature_validation_failed',
    'broadcast_rejected',
    'fee_below_relay_minimum',
    // The payment UTXO is gone, so neither a retry nor a refund can do anything.
    // Requires a human to confirm what actually happened on-chain.
    'inputs_already_spent',
]);

/**
 * Failures where the customer's money is NOT sitting in the payment address any more,
 * so an automatic refund must never be attempted.
 */
const NO_REFUND_FAILURES = new Set(['inputs_already_spent']);

function failure(reason, detail) {
    const permanent = PERMANENT_FAILURES.has(reason);
    if (detail) {
        console.error(`[OpReturnCreator] FAILED (${reason}, permanent=${permanent}): ${detail}`);
    }
    return { ok: false, reason, detail: detail || null, permanent };
}

async function createOpReturnTransaction(request, rootNode, network, config) {
    console.log(`[OpReturnCreator] Starting OP_RETURN creation for request ID: ${request?.id}`);
    if (!request || !config) {
        return failure('internal_error', 'Request or Config object is missing');
    }
    const { id, message, paymentTxId, paymentReceivedSatoshis, derivationPath, address: inputAddress, targetAddress, feeRate, amountToSend, index: requestIndex, payloadKind } = request;
    const coinType = network === bitcoin.networks.bitcoin ? 0 : 1;

    // The backstop, measured in ON-CHAIN bytes via payload.js — for an image row `message`
    // is base64 and a third larger than what actually gets embedded, so checking the
    // string length here would reject payloads that are comfortably within the limit.
    //
    // Bitcoin Core v30 made up to 100,000 bytes standard, but a transaction that large is
    // its own problem and intake caps far below this anyway. This exists to stop a
    // hand-edited row, not to express policy: the real limits are max_payload_size and
    // max_image_payload_size, checked before the customer is quoted.
    let opReturnBuffer;
    try {
        opReturnBuffer = payload.decode(message, payloadKind);
    } catch (e) {
        // Already permanent via PERMANENT_FAILURES: a payload that does not decode will
        // not decode on the next attempt either, so this refunds rather than spins.
        return failure('invalid_message', `request ${id}: ${e.message}`);
    }
    if (!message || opReturnBuffer.length === 0 || opReturnBuffer.length > MAX_ON_CHAIN_PAYLOAD_BYTES) {
        return failure('invalid_message', `message missing or over ${MAX_ON_CHAIN_PAYLOAD_BYTES} on-chain bytes for request ${id}`);
    }
    if (!paymentTxId || !derivationPath || !inputAddress) {
        return failure('missing_payment_details', `request ${id} lacks paymentTxId/derivationPath/address`);
    }

    try {
        const utxoResult = await chainProviders.findUtxoForAddress(paymentTxId, inputAddress, config);
        if (!utxoResult.ok) {
            // Every provider failed, or the payment output genuinely is not there.
            // Transient by default so the retry loop can pick it up again later.
            return failure('utxo_lookup_failed', utxoResult.reason);
        }
        const utxo = utxoResult;
        const inputValue = utxo.value;
        console.log(`[OpReturnCreator] Found UTXO for ${inputAddress} in tx ${paymentTxId}, vout ${utxo.vout}, value ${inputValue} (via ${utxo.provider})`);
        if (paymentReceivedSatoshis != null && inputValue !== paymentReceivedSatoshis) {
            console.warn(`[OpReturnCreator] Recorded payment (${paymentReceivedSatoshis}) differs from on-chain UTXO value (${inputValue}). Using actual.`);
        }

        const opReturnOutput = bitcoin.payments.embed({ data: [opReturnBuffer] });

        // Validate the recipient address before anything is priced, rather than
        // discovering it at broadcast. Both the fee and the dust limit below depend on
        // the script this produces, so it has to be resolved first.
        let targetScript = null;
        if (targetAddress) {
            try {
                targetScript = bitcoin.address.toOutputScript(targetAddress, network);
            } catch (e) {
                return failure('invalid_target_address', `${targetAddress}: ${e.message}`);
            }
        }

        // Fee estimation: input (68) + the OP_RETURN output + change output (31, always
        // P2WPKH) + tx overhead (10), plus the recipient output if present — sized from
        // its own script rather than assumed to be P2WPKH. A flat 31 undercounts a P2WSH
        // recipient by 12 vBytes, which on 2026-08-06 priced two paid orders below the
        // relay minimum at feeRate 2.
        //
        // The OP_RETURN output comes from txSizing, the same function queue.js quotes
        // from, so the estimate and the quote cannot drift. This was `script.length + 9`,
        // which assumes a one-byte script varint and under-counts by 2 vBytes for any
        // script over 252 bytes — invisible while FEE_SAFETY_VBYTES absorbed it, and not
        // something to leave load-bearing now that a payload can be kilobytes.
        //
        // FEE_SAFETY_VBYTES is now pure headroom for the 1-vByte rounding below rather
        // than cover for a known-wrong formula. Underestimating here puts the whole
        // transaction below the minimum relay fee at feeRate=1, where there is no
        // headroom at all, and the network silently refuses to propagate it.
        const FEE_SAFETY_VBYTES = 4;
        let estimatedVBytes = 68 + txSizing.opReturnOutputVBytes(opReturnBuffer.length) + 31 + 10 + FEE_SAFETY_VBYTES;
        if (targetScript) {
            estimatedVBytes += txSizing.outputVBytes(targetScript);
        }
        estimatedVBytes = Math.ceil(estimatedVBytes);

        // Never build below the effective floor: a transaction sitting exactly on the
        // minimum relay fee is rejected as non-standard by real providers.
        const requestedFeeRate = feeRate || appConfig.DEFAULT_FEE_RATE;
        const feeRateSatPerVByte = Math.max(requestedFeeRate, appConfig.MIN_EFFECTIVE_FEE_RATE);
        if (feeRateSatPerVByte !== requestedFeeRate) {
            console.warn(`[OpReturnCreator] Raised fee rate ${requestedFeeRate} to the ${feeRateSatPerVByte} sat/vB floor for request ${id}.`);
        }
        const fee = estimatedVBytes * feeRateSatPerVByte;

        // The change output is always P2WPKH, so the service-wide floor is its limit.
        const DUST_LIMIT = appConfig.DUST_LIMIT_SATS;

        // A recipient output below the dust limit makes the whole transaction
        // non-standard, so relays reject it outright. Intake validation now refuses
        // sub-dust amountToSend values, but clamp here too: this function is also
        // reachable from the admin "Manually Fulfill" button and from historic rows
        // written before that validation existed.
        //
        // The recipient's limit comes from its own script type. A flat 546 passed a
        // 548-sat P2WSH output straight through to BlockCypher, which wants 573 and
        // rejected it as dust after the customer had paid.
        let targetValue = 0;
        if (targetScript) {
            const recipientDustLimit = txSizing.dustLimitForScript(targetScript, appConfig);
            const requested = amountToSend && amountToSend > 0 ? amountToSend : recipientDustLimit;
            targetValue = Math.max(requested, recipientDustLimit);
            if (targetValue !== requested) {
                console.warn(`[OpReturnCreator] Raised sub-dust recipient amount ${requested} to ${recipientDustLimit} (the dust limit for ${targetAddress}) for request ${id}.`);
            }
        }

        const changeValue = inputValue - fee - targetValue;

        console.log(`[OpReturnCreator] Input: ${inputValue} | Fee: ${fee} | Target: ${targetValue} | Change: ${changeValue}`);

        // Outputs must never exceed inputs. Previously this was unchecked, so an
        // underpayment produced an invalid transaction that only failed at broadcast.
        if (changeValue < 0) {
            return failure(
                'insufficient_payment',
                `request ${id}: received ${inputValue} sats but needs at least ${fee + targetValue} (fee ${fee} + recipient ${targetValue})`
            );
        }

        const psbt = new bitcoin.Psbt({ network });
        let usedChangePath = null;

        // Derive the scriptPubKey locally instead of trusting the provider to return it.
        let inputScript;
        try {
            inputScript = bitcoin.address.toOutputScript(inputAddress, network);
        } catch (e) {
            return failure('internal_error', `cannot derive scriptPubKey for our own address ${inputAddress}: ${e.message}`);
        }

        psbt.addInput({
            hash: paymentTxId,
            index: utxo.vout,
            witnessUtxo: {
                script: inputScript,
                value: inputValue,
            },
        });

        psbt.addOutput({ script: opReturnOutput.output, value: 0 });

        if (targetScript) {
            console.log(`[OpReturnCreator] Adding target output: ${targetValue} sats to ${targetAddress}`);
            psbt.addOutput({ script: targetScript, value: targetValue });
        }

        if (changeValue >= DUST_LIMIT) {
            // One change address per request instead of a single reused address.
            // Deriving from the request's own index keeps this deterministic and
            // recoverable from the seed alone, with no extra persisted state.
            const changeIndex = Number.isInteger(requestIndex) ? requestIndex : 0;
            const changePath = `m/84'/${coinType}'/0'/1/${changeIndex}`;
            try {
                const changeAddressNode = rootNode.derivePath(changePath);
                const changePubkeyBuffer = Buffer.from(changeAddressNode.publicKey);
                const { address: derivedChangeAddress } = bitcoin.payments.p2wpkh({ pubkey: changePubkeyBuffer, network: network });
                if (!derivedChangeAddress) throw new Error('Failed to derive change address string.');
                console.log(`[OpReturnCreator] Adding change output: ${changeValue} sats to ${derivedChangeAddress} (${changePath})`);
                psbt.addOutput({
                    address: derivedChangeAddress,
                    value: changeValue,
                });
                usedChangePath = changePath;
            } catch (deriveError) {
                return failure('change_derivation_failed', `path ${changePath}: ${deriveError.message}`);
            }
        } else {
            console.log(`[OpReturnCreator] Change ${changeValue} below dust limit. Absorbed into fee.`);
        }

        let inputKeyPair;
        try {
            inputKeyPair = rootNode.derivePath(derivationPath);
        } catch (deriveError) {
            return failure('key_derivation_failed', `path ${derivationPath}: ${deriveError.message}`);
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

        // Previously this only logged and carried on, so an unsigned or wrongly
        // signed transaction would still be pushed and rejected by the network.
        if (!psbt.validateSignaturesOfInput(0, validator)) {
            return failure('signature_validation_failed', `signature check failed for input 0 of request ${id}`);
        }
        console.log('[OpReturnCreator] Signatures validated successfully.');

        psbt.finalizeAllInputs();
        const transaction = psbt.extractTransaction();
        const signedTxHex = transaction.toHex();
        const newTxId = transaction.getId();

        // Verify against the real signed size rather than the estimate. If the fee we
        // actually deducted is below the minimum relay fee the transaction will not
        // propagate, and it is far better to fail here than to broadcast something that
        // silently never confirms.
        const actualVBytes = transaction.virtualSize();
        const minRelayFee = actualVBytes * appConfig.MIN_EFFECTIVE_FEE_RATE;
        if (fee < minRelayFee) {
            return failure(
                'fee_below_relay_minimum',
                `computed fee ${fee} sats is below the ${minRelayFee} sat minimum for a ${actualVBytes} vByte transaction`
            );
        }
        console.log(`[OpReturnCreator] Transaction signed and finalized. New TXID: ${newTxId} (${actualVBytes} vBytes, fee ${fee} sats)`);

        const broadcast = await chainProviders.broadcastTransaction(signedTxHex, config, newTxId);

        if (broadcast.ok) {
            const txId = broadcast.txId || newTxId;
            if (broadcast.alreadyBroadcast) {
                console.log(`[OpReturnCreator] TX ${txId} was already in the mempool/chain — treating as delivered.`);
            } else {
                console.log(`[OpReturnCreator] Successfully broadcasted OP_RETURN TX: ${txId} (via ${broadcast.provider})`);
            }
            return { ok: true, opReturnTxId: txId, signedTxHex, changePath: usedChangePath };
        }

        // A fee rejection is fixable by rebuilding higher, so it must stay retryable
        // rather than being treated as a permanent rejection.
        if (broadcast.feeTooLow) {
            return failure('fee_too_low', `${broadcast.reason} (paid ${fee} sats at ${feeRateSatPerVByte} sat/vB)`);
        }

        // Inputs already spent almost always means a previous attempt for this request
        // confirmed. Flag it distinctly so the caller never "refunds" money that is gone.
        if (broadcast.inputsSpent) {
            return failure('inputs_already_spent', `${broadcast.reason} (this request's payment UTXO is already spent — verify on-chain before refunding)`);
        }

        // A network-rejected transaction is permanently bad; an unreachable provider is not.
        return failure(
            broadcast.permanent ? 'broadcast_rejected' : 'broadcast_unavailable',
            `${broadcast.reason} (txid would have been ${newTxId})`
        );

    } catch (error) {
        return failure('internal_error', `request ${id}: ${error.message}`);
    }
}

module.exports = {
    createOpReturnTransaction,
    PERMANENT_FAILURES,
    NO_REFUND_FAILURES,
    // Exported so routes/admin.js can clamp the configurable limits against it. A settings
    // value above this ceiling would be quoted to a customer and then refused by the
    // builder AFTER they had paid — the one failure this service exists not to repeat.
    MAX_ON_CHAIN_PAYLOAD_BYTES,
};