// backend/src/chain_providers.js
//
// Multi-provider blockchain access with ordered fallback.
//
// Previously both UTXO lookup and broadcast went exclusively to BlockCypher. A single
// rejection or outage there meant a paid request failed permanently and the customer's
// money sat unfulfilled. Every call here tries providers in order and only gives up
// once all of them have failed.
//
// A provider error is classified as PERMANENT (the transaction itself is invalid, so
// retrying anywhere is pointless) or TRANSIENT (rate limit, outage, network). Only
// transient failures are worth retrying later.

const axios = require('axios');

const HTTP_TIMEOUT_MS = 20000;

// Substrings that indicate the transaction is fundamentally unacceptable to the network.
// Retrying these against another provider or at a later time cannot help.
const PERMANENT_ERROR_PATTERNS = [
    'dust',
    'non-standard',
    'non standard',
    'scriptpubkey',
    'bad-txns',
];

// These are NOT failures. They mean the transaction is already in the mempool or a
// block — i.e. the broadcast succeeded, possibly on an earlier attempt whose HTTP
// response we never saw. Treating them as failures would mark a delivered request as
// failed and then try to refund money that has already been spent.
const ALREADY_BROADCAST_PATTERNS = [
    'txn-already-known',
    'txn-already-in-mempool',
    'already in block chain',
    'transaction already in block chain',
    'already known',
    'duplicate transaction',
];

// The inputs are gone, which almost always means an earlier attempt for this request
// really did confirm. Never auto-refund on this: the funds are no longer there.
const INPUTS_SPENT_PATTERNS = [
    'missing inputs',
    'bad-txns-inputs-missingorspent',
    'inputs-missingorspent',
];

function classifyError(message) {
    const lower = String(message || '').toLowerCase();
    const alreadyBroadcast = ALREADY_BROADCAST_PATTERNS.some((p) => lower.includes(p));
    const inputsSpent = INPUTS_SPENT_PATTERNS.some((p) => lower.includes(p));
    const permanent = !alreadyBroadcast && (inputsSpent || PERMANENT_ERROR_PATTERNS.some((p) => lower.includes(p)));
    return { permanent, alreadyBroadcast, inputsSpent, message: String(message || 'unknown error') };
}

function extractErrorMessage(error) {
    const data = error?.response?.data;
    if (typeof data === 'string' && data.trim()) return data.trim();
    if (data?.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    if (data) return JSON.stringify(data);
    return error?.message || 'unknown error';
}

// --- Provider definitions -------------------------------------------------

// Esplora-compatible hosts (mempool.space and blockstream.info share the same REST shape).
function esploraBase(host, networkName) {
    return networkName === 'main' ? `${host}/api` : `${host}/testnet/api`;
}

function buildProviders(config) {
    const providers = [];

    // BlockCypher first: it is the account the webhooks are registered against, so
    // keeping it primary preserves existing behaviour when it is healthy.
    if (config.BLOCKCYPHER_TOKEN) {
        providers.push({
            name: 'blockcypher',
            async broadcast(txHex) {
                const url = `${config.BLOCKCYPHER_API_BASE}/txs/push?token=${config.BLOCKCYPHER_TOKEN}`;
                const res = await axios.post(url, { tx: txHex }, { timeout: HTTP_TIMEOUT_MS });
                return res.data?.tx?.hash || null;
            },
            async getTxOutputs(txId) {
                const url = `${config.BLOCKCYPHER_API_BASE}/txs/${txId}?token=${config.BLOCKCYPHER_TOKEN}&includeScript=true`;
                const res = await axios.get(url, { timeout: HTTP_TIMEOUT_MS });
                const outputs = res.data?.outputs;
                if (!Array.isArray(outputs)) throw new Error('malformed tx response');
                return outputs.map((o) => ({
                    addresses: o.addresses || [],
                    value: o.value,
                    script: o.script || null,
                }));
            },
            async getTxInputAddresses(txId) {
                const url = `${config.BLOCKCYPHER_API_BASE}/txs/${txId}?token=${config.BLOCKCYPHER_TOKEN}`;
                const res = await axios.get(url, { timeout: HTTP_TIMEOUT_MS });
                const inputs = res.data?.inputs;
                if (!Array.isArray(inputs)) throw new Error('malformed tx response');
                return inputs.flatMap((i) => i.addresses || []).filter(Boolean);
            },
            async getAddressStats(address) {
                const url = `${config.BLOCKCYPHER_API_BASE}/addrs/${address}/balance?token=${config.BLOCKCYPHER_TOKEN}`;
                const res = await axios.get(url, { timeout: HTTP_TIMEOUT_MS });
                return {
                    totalReceived: res.data?.total_received ?? 0,
                    balance: res.data?.final_balance ?? 0,
                };
            },
            async getUnspent(address) {
                const url = `${config.BLOCKCYPHER_API_BASE}/addrs/${address}?unspentOnly=true&token=${config.BLOCKCYPHER_TOKEN}`;
                const res = await axios.get(url, { timeout: HTTP_TIMEOUT_MS });
                return (res.data?.txrefs || [])
                    .filter((r) => !r.spent)
                    .map((r) => ({ txId: r.tx_hash, vout: r.tx_output_n, value: r.value, confirmations: r.confirmations ?? 0 }));
            },
        });
    }

    for (const host of ['https://mempool.space', 'https://blockstream.info']) {
        const base = esploraBase(host, config.NETWORK_NAME);
        providers.push({
            name: host.replace('https://', ''),
            async broadcast(txHex) {
                // Esplora takes the raw hex as the request body and returns the txid as plain text.
                const res = await axios.post(`${base}/tx`, txHex, {
                    headers: { 'Content-Type': 'text/plain' },
                    timeout: HTTP_TIMEOUT_MS,
                });
                return typeof res.data === 'string' ? res.data.trim() : null;
            },
            async getTxOutputs(txId) {
                const res = await axios.get(`${base}/tx/${txId}`, { timeout: HTTP_TIMEOUT_MS });
                const vout = res.data?.vout;
                if (!Array.isArray(vout)) throw new Error('malformed tx response');
                return vout.map((o) => ({
                    addresses: o.scriptpubkey_address ? [o.scriptpubkey_address] : [],
                    value: o.value,
                    script: o.scriptpubkey || null,
                }));
            },
            async getTxInputAddresses(txId) {
                const res = await axios.get(`${base}/tx/${txId}`, { timeout: HTTP_TIMEOUT_MS });
                const vin = res.data?.vin;
                if (!Array.isArray(vin)) throw new Error('malformed tx response');
                return vin.map((v) => v?.prevout?.scriptpubkey_address).filter(Boolean);
            },
            async getAddressStats(address) {
                const res = await axios.get(`${base}/address/${address}`, { timeout: HTTP_TIMEOUT_MS });
                const cs = res.data?.chain_stats || {};
                const ms = res.data?.mempool_stats || {};
                return {
                    totalReceived: (cs.funded_txo_sum || 0) + (ms.funded_txo_sum || 0),
                    balance: (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0),
                };
            },
            async getUnspent(address) {
                const res = await axios.get(`${base}/address/${address}/utxo`, { timeout: HTTP_TIMEOUT_MS });
                return (res.data || []).map((u) => ({
                    txId: u.txid,
                    vout: u.vout,
                    value: u.value,
                    confirmations: u.status?.confirmed ? 1 : 0,
                }));
            },
        });
    }

    return providers;
}

// --- Generic fallback runner ---------------------------------------------

async function tryProviders(config, methodName, args, { label }) {
    const providers = buildProviders(config).filter((p) => typeof p[methodName] === 'function');
    const attempts = [];

    for (const provider of providers) {
        try {
            const result = await provider[methodName](...args);
            if (result !== null && result !== undefined) {
                if (attempts.length > 0) {
                    console.log(`[ChainProviders] ${label} succeeded via ${provider.name} after ${attempts.length} failure(s).`);
                }
                return { ok: true, value: result, provider: provider.name, attempts };
            }
            attempts.push({ provider: provider.name, error: 'empty response' });
        } catch (error) {
            const classified = classifyError(extractErrorMessage(error));
            attempts.push({ provider: provider.name, error: classified.message, permanent: classified.permanent });

            // "Already known" means an earlier attempt succeeded. Report it as success.
            if (classified.alreadyBroadcast) {
                console.log(`[ChainProviders] ${label}: ${provider.name} reports the transaction is already known — treating as success.`);
                return { ok: true, value: null, provider: provider.name, alreadyBroadcast: true, attempts };
            }

            console.warn(`[ChainProviders] ${label} failed via ${provider.name}: ${classified.message}`);

            // A permanently invalid transaction will be rejected identically everywhere.
            if (classified.permanent) {
                return {
                    ok: false, permanent: true, inputsSpent: classified.inputsSpent,
                    reason: classified.message, attempts,
                };
            }
        }
    }

    return {
        ok: false,
        permanent: false,
        reason: attempts.length ? attempts[attempts.length - 1].error : 'no providers configured',
        attempts,
    };
}

/**
 * Broadcasts a signed transaction, falling back across providers.
 *
 * @param {string} txHex
 * @param {object} config
 * @param {string} [expectedTxId] - locally computed txid, used when a provider reports
 *   the transaction is already known and therefore returns no id of its own.
 * @returns {Promise<{ok: true, txId: string, provider: string, alreadyBroadcast?: boolean}
 *   | {ok: false, permanent: boolean, inputsSpent?: boolean, reason: string, attempts: object[]}>}
 */
async function broadcastTransaction(txHex, config, expectedTxId) {
    const result = await tryProviders(config, 'broadcast', [txHex], { label: 'broadcast' });
    if (result.ok) {
        return {
            ok: true,
            txId: result.value || expectedTxId || null,
            provider: result.provider,
            alreadyBroadcast: !!result.alreadyBroadcast,
        };
    }
    return {
        ok: false,
        permanent: !!result.permanent,
        inputsSpent: !!result.inputsSpent,
        reason: result.reason,
        attempts: result.attempts,
    };
}

/**
 * Whether a specific transaction output has already been spent. Used to avoid retrying
 * a request whose payment UTXO is gone — that means an earlier attempt really did
 * confirm, so retrying would build a doomed double-spend and refunding would find
 * nothing to return.
 *
 * Only the Esplora providers expose this, so it is queried directly rather than via
 * the generic runner.
 * @returns {Promise<{ok: true, spent: boolean} | {ok: false, reason: string}>}
 */
async function isOutputSpent(txId, vout, config) {
    for (const host of ['https://mempool.space', 'https://blockstream.info']) {
        const base = esploraBase(host, config.NETWORK_NAME);
        try {
            const res = await axios.get(`${base}/tx/${txId}/outspend/${vout}`, { timeout: HTTP_TIMEOUT_MS });
            if (res.data && typeof res.data.spent === 'boolean') {
                return { ok: true, spent: res.data.spent, spentBy: res.data.txid || null };
            }
        } catch (error) {
            console.warn(`[ChainProviders] outspend check failed via ${host}: ${extractErrorMessage(error)}`);
        }
    }
    return { ok: false, reason: 'all providers failed the outspend check' };
}

/**
 * Finds the output of `txId` that pays `address`, falling back across providers.
 * @returns {Promise<{ok: true, vout: number, value: number, script: string|null} | {ok: false, reason: string}>}
 */
async function findUtxoForAddress(txId, address, config) {
    const result = await tryProviders(config, 'getTxOutputs', [txId], { label: `utxo-lookup ${txId.slice(0, 12)}` });
    if (!result.ok) {
        return { ok: false, reason: result.reason };
    }

    const outputs = result.value;
    for (let i = 0; i < outputs.length; i++) {
        if (outputs[i].addresses.includes(address)) {
            return { ok: true, vout: i, value: outputs[i].value, script: outputs[i].script, provider: result.provider };
        }
    }
    return { ok: false, reason: `no output paying ${address} in tx ${txId}` };
}

/**
 * Total satoshis ever received by an address. Used to guarantee the cleanup job
 * never deletes a request that a customer has actually paid.
 */
async function getAddressStats(address, config) {
    const result = await tryProviders(config, 'getAddressStats', [address], { label: `address-stats ${address.slice(0, 12)}` });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, ...result.value, provider: result.provider };
}

/**
 * Resolves the payer's address by reading the funding transaction's inputs from a
 * blockchain provider.
 *
 * This is deliberately NOT taken from the webhook request body: that endpoint is
 * unauthenticated, so a forged notification could otherwise set the refund destination
 * to an attacker's address and have a later refund pay them instead of the customer.
 *
 * @returns {Promise<{ok: true, address: string} | {ok: false, reason: string}>}
 */
async function getPayerAddress(txId, config) {
    const result = await tryProviders(config, 'getTxInputAddresses', [txId], { label: `payer-lookup ${String(txId).slice(0, 12)}` });
    if (!result.ok) return { ok: false, reason: result.reason };
    const addresses = result.value || [];
    if (addresses.length === 0) return { ok: false, reason: 'transaction has no resolvable input addresses' };
    return { ok: true, address: addresses[0], provider: result.provider };
}

/** Confirmed unspent outputs for an address, used by the refund path. */
async function getUnspent(address, config) {
    const result = await tryProviders(config, 'getUnspent', [address], { label: `utxos ${address.slice(0, 12)}` });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, utxos: result.value, provider: result.provider };
}

module.exports = {
    broadcastTransaction,
    findUtxoForAddress,
    getAddressStats,
    getUnspent,
    isOutputSpent,
    getPayerAddress,
    classifyError,
};
