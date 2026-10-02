// backend/src/queue.js
const { v4: uuidv4 } = require('uuid');
const bitcoin = require('bitcoinjs-lib');
const txSizing = require('./tx_sizing');
const payload = require('./payload');
const lightning = require('./lightning');

const requestProcessingQueue = [];
let isProcessing = false;

async function processNextInQueue(db, rootNode, config) {
    if (isProcessing || requestProcessingQueue.length === 0) {
        return;
    }
    isProcessing = true;
    const { message, targetAddress, feeRate, amountToSend, payloadKind, paymentMethod, resolve, reject } = requestProcessingQueue.shift();

    try {
        const nextIndex = await new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run("UPDATE wallet_state SET last_derived_index = last_derived_index + 1 WHERE id = 1", function(err) {
                    if (err) reject(err);
                });
                db.get("SELECT last_derived_index FROM wallet_state WHERE id = 1", (err, row) => {
                    if (err) return reject(err);
                    if (!row) return reject(new Error("Wallet state not initialized"));
                    resolve(row.last_derived_index);
                });
            });
        });

        const coinType = config.NETWORK === bitcoin.networks.bitcoin ? 0 : 1;
        const derivationPath = `m/84'/${coinType}'/0'/0/${nextIndex}`;
        const childNode = rootNode.derivePath(derivationPath);
        const pubkeyBuffer = Buffer.from(childNode.publicKey);
        const address = bitcoin.payments.p2wpkh({ pubkey: pubkeyBuffer, network: config.NETWORK }).address;

        // Calculate required amount.
        // The trailing 31 is the change output, which we always derive as P2WPKH. The
        // recipient output is sized from its own script: a flat 31 assumed P2WPKH there
        // too, and under-quoting a 43-byte P2WSH output by 12 vBytes is what left four
        // orders on 2026-08-06 priced below the minimum relay fee once actually built.
        // targetAddress has already been through validateRequestParams, so it parses.
        //
        // payload.byteLength, NOT Buffer.byteLength(message): for an image row `message`
        // holds base64 and the chain gets the decoded bytes, which are a third smaller.
        // Quoting from the stored string would overcharge every image customer by 33%.
        //
        // The OP_RETURN output size comes from txSizing rather than the `11 + bytes` this
        // line used to hand-roll. That form assumed a one-byte push prefix and a one-byte
        // script varint, both of which stop being true past 75 bytes — it under-quoted a
        // 1000-byte message by 4 vBytes even at the limit that was already live.
        const messageBytes = payload.byteLength(message, payloadKind);
        const isLightning = paymentMethod === lightning.LIGHTNING;

        let effectiveFeeRate;
        let effectiveAmountToSend;
        let requiredAmountSatoshis;
        if (isLightning) {
            // A Lightning order is published out of the treasury, so it is priced from the
            // treasury builder's own estimate — see lightning.js quote. The customer does
            // not pay for an input of their own, and pays for the treasury's safety margin.
            const q = lightning.quote({ messageBytes, targetAddress, feeRate, amountToSend }, config);
            effectiveFeeRate = feeRate || config.DEFAULT_FEE_RATE;
            effectiveAmountToSend = q.customerAmount;
            requiredAmountSatoshis = q.requiredAmountSatoshis;
        } else {
            let estimatedVBytes = 10.5 + 68 + txSizing.opReturnOutputVBytes(messageBytes) + 31;
            if (targetAddress) {
                estimatedVBytes += txSizing.outputVBytesForAddress(targetAddress, config.NETWORK);
            }
            estimatedVBytes = Math.ceil(estimatedVBytes);

            effectiveFeeRate = feeRate || config.DEFAULT_FEE_RATE;
            const serviceFee = config.SERVICE_FEE_SATS;
            const networkFee = estimatedVBytes * effectiveFeeRate;

            // Only charge for a recipient payout when there is actually somewhere to send it.
            // Without this guard, amountToSend with no targetAddress was billed to the customer
            // but never paid out — it silently ended up in the service change output.
            effectiveAmountToSend = targetAddress ? (amountToSend || 0) : 0;
            requiredAmountSatoshis = networkFee + serviceFee + effectiveAmountToSend;
        }

        const newRequestId = uuidv4();

        // Persist the same fee rate that was quoted, rather than a separate hardcoded
        // default, so the quote and the later fulfilment can never drift apart.
        // payloadKind is named in the INSERT rather than left to the column default. The
        // default is NULL, which payload.js reads as text — correct for a text order, and
        // silently wrong for an image one, whose message would then be priced and embedded
        // as literal base64 characters. Same reasoning as isPublic: never rely on a
        // default for a value the customer chose.
        //
        // paymentMethod likewise: NULL is on-chain, which is what every older row is.
        const params = [newRequestId, message, address, derivationPath, nextIndex, requiredAmountSatoshis, 'pending_payment', new Date().toISOString(), targetAddress || null, effectiveFeeRate, effectiveAmountToSend, payload.normalizeKind(payloadKind), isLightning ? lightning.LIGHTNING : null];
        await new Promise((res, rej) => {
            db.run('INSERT INTO requests (id, message, address, derivationPath, "index", requiredAmountSatoshis, status, createdAt, targetAddress, feeRate, amountToSend, payloadKind, paymentMethod) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', params, (err) => err ? rej(err) : res());
        });

        console.log(`[Queue] New request processed: ID ${newRequestId}`);
        resolve({ newRequestId, address, requiredAmountSatoshis });

    } catch (error) {
        console.error("[Queue] Error processing request:", error);
        reject(error);
    } finally {
        isProcessing = false;
        if (requestProcessingQueue.length > 0) {
            processNextInQueue(db, rootNode, config);
        }
    }
}

// payloadKind and paymentMethod are trailing and optional so the existing 7-argument
// positional call keeps working and defaults to an on-chain text order. The signature is
// already awkward; widening it further was the smaller evil against threading an options
// object through every caller.
function add(message, targetAddress, feeRate, amountToSend, db, rootNode, config, payloadKind, paymentMethod) {
    return new Promise((resolve, reject) => {
        requestProcessingQueue.push({ message, targetAddress, feeRate, amountToSend, payloadKind, paymentMethod, resolve, reject });
        console.log(`[Queue] Added to queue. Length: ${requestProcessingQueue.length}`);
        processNextInQueue(db, rootNode, config);
    });
}

module.exports = { add };
