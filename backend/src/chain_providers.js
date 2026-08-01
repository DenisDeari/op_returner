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
// Read-only address lookups get a tighter deadline than a broadcast does. A wallet scan
// issues a great many of them, and waiting the full 20 s on a rate-limited host before
// falling back to the next one is what made an early version of the scan take 87 s.
const LOOKUP_TIMEOUT_MS = 8000;
// How many addresses a wallet scan derives and looks up per round. Not a provider batch
// — the Esplora hosts have no multi-address endpoint, so these still go out as
// individual requests, throttled by WALLET_SCAN_CONCURRENCY. It only sets how far ahead
// the scan looks before deciding whether the gap limit has been reached.
const SUMMARY_BATCH_SIZE = 20;

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

// The transaction is well-formed but underpays. NOT permanent: another provider may
// have a lower threshold, and rebuilding at a higher fee rate fixes it outright.
// These must be matched BEFORE the generic patterns, because providers phrase it as
// "non standard: low fee rate" — which would otherwise look permanent and both skip
// the fallback providers and stop the request from ever being retried.
const FEE_TOO_LOW_PATTERNS = [
    'low fee rate',
    'min relay fee not met',
    'mempool min fee not met',
    'insufficient fee',
    'fee too low',
    'min_relay_fee',
    'tx-fee-too-low',
];

function classifyError(message) {
    const lower = String(message || '').toLowerCase();
    const alreadyBroadcast = ALREADY_BROADCAST_PATTERNS.some((p) => lower.includes(p));
    const feeTooLow = FEE_TOO_LOW_PATTERNS.some((p) => lower.includes(p));
    const inputsSpent = INPUTS_SPENT_PATTERNS.some((p) => lower.includes(p));
    const permanent = !alreadyBroadcast && !feeTooLow
        && (inputsSpent || PERMANENT_ERROR_PATTERNS.some((p) => lower.includes(p)));
    return { permanent, alreadyBroadcast, feeTooLow, inputsSpent, message: String(message || 'unknown error') };
}

function extractErrorMessage(error) {
    const data = error?.response?.data;
    let message;
    if (typeof data === 'string' && data.trim()) message = data.trim();
    else if (data?.error) message = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    else if (data) message = JSON.stringify(data);
    // A connection that never got as far as a response carries no body and, for Node's
    // AggregateError, an empty message too — which used to surface as a bare
    // "unknown error" that said nothing about what went wrong. Fall back to the syscall
    // code so the log names the actual problem.
    else message = error?.message || error?.code || 'unknown error';

    // Prefixed rather than substituted, so every existing classification pattern still
    // matches on the original text.
    const status = error?.response?.status;
    const code = !status && error?.code && !String(message).includes(error.code) ? `${error.code}: ` : '';
    return status ? `HTTP ${status}: ${message}` : `${code}${message}`;
}

// A host that is rate-limiting us, or that we cannot connect to, is tried last for a
// while. Without this a wallet scan pays the same failure once per address: connections
// from this machine to mempool.space time out most of the time — not always, it does get
// through intermittently — which cost about two seconds on each of 160 lookups before
// the host was demoted.
//
// Cooling down only reorders providers, never removes one, and callers must opt in. It
// is deliberately NOT used for broadcasts; see the note in tryProviders.
const UNHEALTHY_PROVIDER_PATTERNS = [
    // rate limiting
    'http 429', 'too many requests', 'rate limit', 'rate-limit',
    // transport: the request never reached the service
    'etimedout', 'econnrefused', 'econnreset', 'enotfound', 'enetunreach',
    'ehostunreach', 'eai_again', 'socket hang up', 'timeout of',
];
const PROVIDER_COOLDOWN_MS = 60 * 1000;
const providerCooldowns = new Map(); // provider name -> epoch ms until which it is deprioritised

function isProviderUnhealthy(message) {
    const lower = String(message || '').toLowerCase();
    return UNHEALTHY_PROVIDER_PATTERNS.some((p) => lower.includes(p));
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
            async getAddressSummary(address) {
                const url = `${config.BLOCKCYPHER_API_BASE}/addrs/${address}/balance?token=${config.BLOCKCYPHER_TOKEN}`;
                const res = await axios.get(url, { timeout: LOOKUP_TIMEOUT_MS });
                return normalizeBlockcypherBalance(res.data || {});
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
            async getAddressSummary(address) {
                const res = await axios.get(`${base}/address/${address}`, { timeout: LOOKUP_TIMEOUT_MS });
                const cs = res.data?.chain_stats || {};
                const ms = res.data?.mempool_stats || {};
                return {
                    confirmed: (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0),
                    unconfirmed: (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0),
                    // Note: this counts every output paying the address, including change
                    // the address sent back to itself, so for a self-spending address like
                    // the treasury it reads far higher than BlockCypher's total_received,
                    // which nets those out. Both are self-consistent and both give the
                    // same balance. Only balance and txCount are comparable across
                    // providers, so those are the numbers the wallet view relies on.
                    totalReceived: (cs.funded_txo_sum || 0) + (ms.funded_txo_sum || 0),
                    totalSent: (cs.spent_txo_sum || 0) + (ms.spent_txo_sum || 0),
                    txCount: (cs.tx_count || 0) + (ms.tx_count || 0),
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

async function tryProviders(config, methodName, args, { label, onlyProviders, useCooldown = false }) {
    let providers = buildProviders(config).filter((p) => typeof p[methodName] === 'function');

    // Some callers restrict which hosts may answer at all. The wallet view does: it
    // issues one request per derived address, and BlockCypher bills each one against the
    // free-tier quota that the payment webhooks and broadcasts depend on. A *preference*
    // was not enough — once a preferred host was demoted for rate-limiting, BlockCypher
    // moved up and got the traffic anyway. This is a hard restriction so the invariant
    // holds no matter what order things end up in.
    if (onlyProviders && onlyProviders.length) {
        const rank = (p) => onlyProviders.indexOf(p.name);
        providers = providers.filter((p) => rank(p) !== -1).sort((a, b) => rank(a) - rank(b));
    }

    // Reordering is opt-in, and deliberately NOT used for broadcasts.
    //
    // tryProviders stops at the first PERMANENT rejection and never consults the
    // remaining hosts. So changing the order changes which host gets to pronounce a
    // transaction permanently invalid — and a permanent rejection is what triggers an
    // automatic refund. A wallet scan hitting a rate limit must not be able to reshuffle
    // that and turn a deliverable order into a refunded one.
    if (useCooldown && providers.length > 1 && providerCooldowns.size > 0) {
        const now = Date.now();
        const cooling = (p) => ((providerCooldowns.get(p.name) || 0) > now ? 1 : 0);
        // Stable sort, so the order chosen above survives among hosts of equal health.
        providers = [...providers].sort((a, b) => cooling(a) - cooling(b));
    }

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

            if (isProviderUnhealthy(classified.message)) {
                const until = Date.now() + PROVIDER_COOLDOWN_MS;
                if (!(providerCooldowns.get(provider.name) > Date.now())) {
                    console.warn(`[ChainProviders] ${provider.name} looks unhealthy (${classified.message}); trying it last for the next ${PROVIDER_COOLDOWN_MS / 1000}s.`);
                }
                providerCooldowns.set(provider.name, until);
            }

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
            // A fee rejection is worth trying elsewhere — thresholds differ per provider —
            // so fall through to the next one rather than giving up here.
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
        feeTooLow: (result.attempts || []).some((a) => FEE_TOO_LOW_PATTERNS.some((p) => String(a.error).toLowerCase().includes(p))),
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

/** Maps a BlockCypher /balance payload onto the shape the wallet view expects. */
function normalizeBlockcypherBalance(d) {
    return {
        confirmed: d.balance ?? 0,
        unconfirmed: d.unconfirmed_balance ?? 0,
        totalReceived: d.total_received ?? 0,
        totalSent: d.total_sent ?? 0,
        txCount: (d.n_tx ?? 0) + (d.unconfirmed_n_tx ?? 0),
    };
}

/**
 * Balances for many addresses, fetched a few at a time.
 *
 * BlockCypher does have a multi-address endpoint, and an earlier version of this used
 * it. It was removed: BlockCypher bills each address in the batch against the quota, so
 * a single wallet scan returned twenty 429s at once and spent the allowance that the
 * payment webhooks and broadcasts depend on. Scanning must never cost the money paths
 * their API budget, so it stays on the Esplora hosts, which have no such limit and are
 * not used for webhook registration.
 *
 * @param {string[]} addresses
 * @returns {Promise<Map<string, object>>} address -> {ok: true, …} | {ok: false, reason}
 */
async function getAddressSummaries(addresses, config, { deadline = null } = {}) {
    const results = new Map();
    const wanted = [...new Set(addresses)];
    if (wanted.length === 0) return results;

    const past = () => deadline !== null && Date.now() > deadline;

    const concurrency = config.WALLET_SCAN_CONCURRENCY || 4;
    for (let i = 0; i < wanted.length; i += concurrency) {
        // Checked per chunk, not just by the caller between batches. With both hosts
        // failing, one round costs two timeouts, and a 20-address batch is five rounds —
        // long enough to blow the whole scan budget before control ever returns upstream.
        if (past()) break;
        const chunk = wanted.slice(i, i + concurrency);
        await Promise.all(chunk.map(async (address) => {
            results.set(address, await getAddressSummary(address, config));
        }));
    }

    // One gentle retry for whatever failed. Rate limits are transient by definition, and
    // a single address that came back empty would otherwise be reported as an unknown
    // balance until the cache expires.
    //
    // Bounded on both count and wall-clock: this runs inside an admin HTTP request, and
    // an unbounded sequential retry over a large failed set would hold that request open
    // for minutes while hammering hosts that are already refusing us.
    const MAX_RETRIES = 6;
    const RETRY_DEADLINE_MS = 6000;
    const failed = wanted.filter((a) => !results.get(a)?.ok);
    if (failed.length > 0 && failed.length < wanted.length && !past()) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const retryDeadline = Math.min(
            Date.now() + RETRY_DEADLINE_MS,
            deadline === null ? Infinity : deadline
        );
        for (const address of failed.slice(0, MAX_RETRIES)) {
            if (Date.now() > retryDeadline) break;
            const retry = await getAddressSummary(address, config);
            if (retry.ok) results.set(address, retry);
        }
    }

    return results;
}

/**
 * Full balance picture for one address, used by the wallet view.
 *
 * Deliberately richer than getAddressStats: the wallet needs to distinguish confirmed
 * from unconfirmed money and to know whether an address has ever been used at all,
 * which is what the gap-limit scan decides on.
 *
 * Esplora hosts are tried first. A scan touches dozens of addresses, and putting
 * BlockCypher first would exhaust its free-tier quota and then fail the money paths
 * that genuinely depend on it.
 *
 * @returns {Promise<{ok: true, confirmed: number, unconfirmed: number, totalReceived: number,
 *   totalSent: number, txCount: number, provider: string} | {ok: false, reason: string}>}
 */
async function getAddressSummary(address, config) {
    // Esplora hosts ONLY — never BlockCypher. See the note in tryProviders: a scan would
    // otherwise spend the API quota that the money paths depend on.
    const result = await tryProviders(config, 'getAddressSummary', [address], {
        label: `address-summary ${address.slice(0, 12)}`,
        onlyProviders: ['blockstream.info', 'mempool.space'],
        useCooldown: true,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, ...result.value, provider: result.provider };
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
    getAddressSummary,
    getAddressSummaries,
    getUnspent,
    SUMMARY_BATCH_SIZE,
    isOutputSpent,
    getPayerAddress,
    classifyError,
};
