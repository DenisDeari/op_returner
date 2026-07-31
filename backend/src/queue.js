// backend/src/queue.js
const { v4: uuidv4 } = require('uuid');
const bitcoin = require('bitcoinjs-lib');

const requestProcessingQueue = [];
let isProcessing = false;

async function processNextInQueue(db, rootNode, config) {
    if (isProcessing || requestProcessingQueue.length === 0) {
        return;
    }
    isProcessing = true;
    const { message, targetAddress, feeRate, amountToSend, resolve, reject } = requestProcessingQueue.shift();

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

        // Calculate required amount
        const messageBytes = Buffer.byteLength(message, 'utf8');
        let estimatedVBytes = 10.5 + 68 + (11 + messageBytes) + 31;
        if (targetAddress) {
            estimatedVBytes += 31;
        }
        estimatedVBytes = Math.ceil(estimatedVBytes);

        const effectiveFeeRate = feeRate || config.DEFAULT_FEE_RATE;
        const serviceFee = config.SERVICE_FEE_SATS;
        const networkFee = estimatedVBytes * effectiveFeeRate;

        // Only charge for a recipient payout when there is actually somewhere to send it.
        // Without this guard, amountToSend with no targetAddress was billed to the customer
        // but never paid out — it silently ended up in the service change output.
        const effectiveAmountToSend = targetAddress ? (amountToSend || 0) : 0;
        const requiredAmountSatoshis = networkFee + serviceFee + effectiveAmountToSend;

        const newRequestId = uuidv4();

        // Persist the same fee rate that was quoted, rather than a separate hardcoded
        // default, so the quote and the later fulfilment can never drift apart.
        const params = [newRequestId, message, address, derivationPath, nextIndex, requiredAmountSatoshis, 'pending_payment', new Date().toISOString(), targetAddress || null, effectiveFeeRate, effectiveAmountToSend];
        await new Promise((res, rej) => {
            db.run('INSERT INTO requests (id, message, address, derivationPath, "index", requiredAmountSatoshis, status, createdAt, targetAddress, feeRate, amountToSend) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', params, (err) => err ? rej(err) : res());
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

function add(message, targetAddress, feeRate, amountToSend, db, rootNode, config) {
    return new Promise((resolve, reject) => {
        requestProcessingQueue.push({ message, targetAddress, feeRate, amountToSend, resolve, reject });
        console.log(`[Queue] Added to queue. Length: ${requestProcessingQueue.length}`);
        processNextInQueue(db, rootNode, config);
    });
}

module.exports = { add };
