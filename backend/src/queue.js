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
    const { message, targetAddress, isPublic, feeRate, amountToSend, refundAddress, resolve, reject } = requestProcessingQueue.shift();

    try {
        // FIX: Use persistent wallet_state to generate next index, preventing address reuse
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
        
        // --- THIS IS THE FIX ---
        // We must convert the public key from a Uint8Array to a Buffer.
        const pubkeyBuffer = Buffer.from(childNode.publicKey);
        const address = bitcoin.payments.p2wpkh({ pubkey: pubkeyBuffer, network: config.NETWORK }).address;
        // --- END OF FIX ---

        // Calculate required amount
        // Dynamic vByte calculation based on message size
        const messageBytes = Buffer.byteLength(message, 'utf8');
        let estimatedVBytes = 10.5 + 68 + (11 + messageBytes) + 31;
        
        if (targetAddress) {
            estimatedVBytes += 31;
        }
        
        estimatedVBytes = Math.ceil(estimatedVBytes);

        const serviceFee = 2000;
        const networkFee = estimatedVBytes * (feeRate || 2);
        const requiredAmountSatoshis = networkFee + serviceFee + (amountToSend || 0);

        const newRequestId = uuidv4();

        const params = [newRequestId, message, address, derivationPath, nextIndex, requiredAmountSatoshis, 'pending_payment', new Date().toISOString(), targetAddress || null, isPublic ? 1 : 0, feeRate || 2, amountToSend || 0, refundAddress || null];
        await new Promise((res, rej) => {
            db.run('INSERT INTO requests (id, message, address, derivationPath, "index", requiredAmountSatoshis, status, createdAt, targetAddress, isPublic, feeRate, amountToSend, refundAddress) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', params, (err) => err ? rej(err) : res());
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

function add(message, targetAddress, isPublic, feeRate, amountToSend, refundAddress, db, rootNode, config) {
    return new Promise((resolve, reject) => {
        requestProcessingQueue.push({ message, targetAddress, isPublic, feeRate, amountToSend, refundAddress, resolve, reject });
        console.log(`[Queue] Added to queue. Length: ${requestProcessingQueue.length}`);
        processNextInQueue(db, rootNode, config);
    });
}

module.exports = { add };
