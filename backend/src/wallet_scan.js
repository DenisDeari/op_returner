// backend/src/wallet_scan.js
//
// Read-only view of every satoshi the service seed controls.
//
// The admin panel previously showed exactly two hard-coded addresses: the treasury and
// the very first receive address. Everything else the wallet owns — the per-order
// payment addresses, and above all the change outputs where the operator's actual
// revenue accumulates — was invisible.
//
// A normal wallet (Electrum, Sparrow) cannot fill the gap either. Those scan only the
// standard receive branch (.../0/i) and change branch (.../1/i) of an account. The
// treasury lives at m/84'/0'/0'/2/0, on a branch no BIP44-derived wallet ever looks at,
// so its balance simply does not appear. That is the reason this module exists and the
// reason arbitrary derivation paths can be scanned by hand.
//
// Nothing here signs or spends. It derives addresses and asks a block explorer what it
// sees, so the worst a bug can do is display a wrong number.

const bitcoin = require('bitcoinjs-lib');
const chainProviders = require('./chain_providers');
const { dbAll, dbGet, dbRun } = require('./db_utils');

// --- Address types --------------------------------------------------------
// The service itself only ever uses P2WPKH. The others exist because the operator may
// point the manual scanner at a path belonging to some other tool, and a path alone does
// not say which script type was used with it.
const ADDRESS_TYPES = {
    p2wpkh: 'Native SegWit (bc1q…)',
    p2tr: 'Taproot (bc1p…)',
    p2sh_p2wpkh: 'Nested SegWit (3…)',
    p2pkh: 'Legacy (1…)',
};

let taprootReady = false;
function ensureTaprootReady() {
    // bitcoinjs-lib needs an ECC backend registered before it can build a Taproot output.
    // Done lazily so requiring this module never changes global library state for the
    // signing paths unless a Taproot address is actually asked for.
    if (taprootReady) return;
    // eslint-disable-next-line global-require
    bitcoin.initEccLib(require('tiny-secp256k1'));
    taprootReady = true;
}

/**
 * Derives one address from the seed.
 * @param {object} rootNode - BIP32 root node
 * @param {string} path - full BIP32 path, e.g. "m/84'/0'/0'/2/0"
 * @param {string} type - key of ADDRESS_TYPES
 */
function deriveAddress(rootNode, path, type, network) {
    const node = rootNode.derivePath(path);
    const pubkey = Buffer.from(node.publicKey);

    switch (type) {
        case 'p2wpkh':
            return bitcoin.payments.p2wpkh({ pubkey, network }).address;
        case 'p2pkh':
            return bitcoin.payments.p2pkh({ pubkey, network }).address;
        case 'p2sh_p2wpkh':
            return bitcoin.payments.p2sh({
                redeem: bitcoin.payments.p2wpkh({ pubkey, network }),
                network,
            }).address;
        case 'p2tr':
            ensureTaprootReady();
            // Taproot uses the 32-byte x-only key, i.e. the compressed pubkey without
            // its leading parity byte.
            return bitcoin.payments.p2tr({ internalPubkey: pubkey.subarray(1, 33), network }).address;
        default:
            throw new Error(`unknown address type: ${type}`);
    }
}

// --- Path parsing ---------------------------------------------------------

const PATH_PATTERN = /^m(\/\d+'?)*$/;
const HARDENED_OFFSET = 2147483648; // 2^31

/**
 * Validates and normalises a user-supplied derivation path.
 *
 * The path reaches this function straight from an admin form field, and it is fed to
 * derivePath, so it is checked rather than trusted: h/H hardened notation is accepted
 * and rewritten, every index must fit BIP32's range, and the depth is capped far below
 * anything a real wallet uses so a pasted absurdity cannot spin the CPU.
 *
 * @returns {{ok: true, path: string, depth: number} | {ok: false, reason: string}}
 */
function normalizePath(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return { ok: false, reason: 'Enter a derivation path, for example m/84\'/0\'/0\'/2' };

    const path = raw.replace(/[hH]/g, "'");
    if (!PATH_PATTERN.test(path)) {
        return { ok: false, reason: `"${raw}" is not a valid path. Expected something like m/84'/0'/0'/2` };
    }

    const segments = path === 'm' ? [] : path.split('/').slice(1);
    if (segments.length > 8) {
        return { ok: false, reason: 'That path is deeper than 8 levels — check it for a typo.' };
    }
    for (const segment of segments) {
        const index = Number.parseInt(segment.replace("'", ''), 10);
        if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
            return { ok: false, reason: `"${segment}" is not a usable index (must be 0 – ${HARDENED_OFFSET - 1}).` };
        }
    }
    return { ok: true, path, depth: segments.length };
}

// --- Balance lookups with a short cache -----------------------------------
// A scan asks about dozens of addresses and the panel gets refreshed repeatedly. Without
// this, every refresh would be a fresh burst of explorer requests.

const summaryCache = new Map(); // address -> { at: epochMs, value }

function clearSummaryCache() {
    summaryCache.clear();
}

// The cache is also written to the database, for one reason: a scan that runs into a
// rate limit with an empty cache would otherwise display a balance of zero. Showing the
// operator "0 sats" when the wallet actually holds funds is the worst thing this panel
// could do, so the last figure known to be good survives a restart and is shown with its
// age attached.
const CACHE_SETTING_KEY = 'wallet_balance_cache';
const MAX_PERSISTED_ADDRESSES = 500;
let cacheLoaded = false;

async function ensureCacheLoaded(db) {
    if (cacheLoaded) return;
    cacheLoaded = true; // set first: a failed load must not retry on every request
    try {
        const row = await dbGet(db, 'SELECT value FROM system_settings WHERE key = ?', [CACHE_SETTING_KEY]);
        if (!row || !row.value) return;
        const parsed = JSON.parse(row.value);
        // Validated field by field, not just shape-checked. These numbers are added
        // straight into the displayed total, and a malformed entry would turn it into
        // NaN or "0 sats" — the one thing this cache exists to prevent.
        const isBalance = (v) => Number.isFinite(v.confirmed) && Number.isFinite(v.unconfirmed)
            && Number.isFinite(v.txCount) && v.ok === true;
        for (const [address, entry] of Object.entries(parsed)) {
            if (entry && Number.isFinite(entry.at) && entry.at > 0 && entry.value && isBalance(entry.value)) {
                summaryCache.set(address, entry);
            }
        }
        console.log(`[Wallet] Loaded ${summaryCache.size} cached address balances.`);
    } catch (error) {
        console.warn(`[Wallet] Could not load the balance cache: ${error.message}`);
    }
}

async function persistCache(db) {
    try {
        // Newest first, then truncated, so a long-lived wallet cannot grow this row
        // without bound.
        const entries = [...summaryCache.entries()]
            .sort((a, b) => b[1].at - a[1].at)
            .slice(0, MAX_PERSISTED_ADDRESSES);
        const payload = Object.fromEntries(entries);
        await dbRun(
            db,
            'INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)',
            [CACHE_SETTING_KEY, JSON.stringify(payload)]
        );
    } catch (error) {
        // Losing the cache costs nothing but speed.
        console.warn(`[Wallet] Could not save the balance cache: ${error.message}`);
    }
}

/**
 * Balances for a list of addresses, served from cache where possible and fetched in one
 * batched call otherwise.
 *
 * @returns {Promise<Map<string, object>>}
 */
async function getSummaries(addresses, config, { refresh = false, deadline = null } = {}) {
    const ttl = config.WALLET_CACHE_TTL_MS;
    const now = Date.now();
    const out = new Map();
    const toFetch = [];
    const outOfTime = deadline !== null && now > deadline;

    for (const address of addresses) {
        const cached = summaryCache.get(address);
        if (!refresh && cached && now - cached.at < ttl) {
            out.set(address, { ...cached.value, cached: true });
        } else if (outOfTime) {
            // Past the budget: no more network calls. Serve the last known figure,
            // flagged stale, rather than making the caller wait.
            if (cached) {
                out.set(address, { ...cached.value, cached: true, stale: true, cachedAt: cached.at, staleReason: 'scan ran out of time' });
            } else {
                out.set(address, { ok: false, reason: 'scan ran out of time before this address was checked' });
            }
        } else {
            toFetch.push(address);
        }
    }

    if (toFetch.length > 0) {
        const fetched = await chainProviders.getAddressSummaries(toFetch, config, { deadline });
        for (const address of toFetch) {
            const result = fetched.get(address) || { ok: false, reason: 'no answer from any provider' };
            if (result.ok) {
                summaryCache.set(address, { at: Date.now(), value: result });
                out.set(address, { ...result, cached: false });
                continue;
            }

            // The lookup failed. If this address was read successfully at some point,
            // show that older figure rather than nothing: a rate limit that hits halfway
            // through a scan must not make a funded address look empty. It is flagged
            // stale so the panel can say how old it is.
            const previous = summaryCache.get(address);
            if (previous) {
                out.set(address, { ...previous.value, cached: true, stale: true, cachedAt: previous.at, staleReason: result.reason });
            } else {
                out.set(address, result);
            }
        }
    }

    return out;
}

async function getSummary(address, config, options = {}) {
    const map = await getSummaries([address], config, options);
    return map.get(address) || { ok: false, reason: 'no answer from any provider' };
}

/** True once an address has ever been touched — what the gap limit counts. */
function isUsed(entry) {
    return (entry.txCount || 0) > 0 || (entry.totalReceived || 0) > 0;
}

// --- Branch scanning ------------------------------------------------------

/**
 * Walks the addresses under a branch until `gapLimit` consecutive unused ones are seen.
 *
 * Lookup failures are never counted as "unused". Treating a failed explorer call as an
 * empty address would let a transient outage end the scan early and quietly report a
 * balance that is missing money. Instead they are recorded, and once too many pile up
 * the scan stops and marks itself incomplete rather than reporting a total that cannot
 * be trusted.
 *
 * @returns {Promise<{addresses: object[], incomplete: boolean, incompleteReason: string|null,
 *   scanned: number, errors: number}>}
 */
async function scanBranch(rootNode, branch, config, options = {}) {
    const gapLimit = options.gapLimit ?? config.WALLET_GAP_LIMIT;
    const maxIndices = options.maxIndices ?? config.WALLET_MAX_SCAN_INDICES;
    const minIndices = options.minIndices ?? 0;
    // One window is one batched provider call. Sized to the gap limit so the scan can
    // usually decide to stop after a single round trip, but never larger than the batch
    // the provider will accept.
    const windowSize = Math.max(1, Math.min(chainProviders.SUMMARY_BATCH_SIZE, gapLimit + 5));
    const refresh = !!options.refresh;
    const deadline = options.deadline ?? null;

    const addresses = [];
    let consecutiveUnused = 0;
    let errors = 0;
    let incompleteReason = null;
    let index = 0;

    while (index < maxIndices) {
        // Derive the whole window first, then ask for all of its balances in one go.
        const derived = [];
        for (let i = 0; i < windowSize && index + i < maxIndices; i++) {
            const at = index + i;
            const path = `${branch.path}/${at}`;
            try {
                derived.push({ index: at, path, address: deriveAddress(rootNode, path, branch.type, config.NETWORK) });
            } catch (error) {
                derived.push({ index: at, path, address: null, error: `could not derive: ${error.message}` });
            }
        }

        const summaries = await getSummaries(
            derived.filter((d) => d.address).map((d) => d.address),
            config,
            { refresh, deadline }
        );

        const entries = derived.map((d) => {
            if (!d.address) return d;
            const summary = summaries.get(d.address);
            if (!summary || !summary.ok) {
                return { ...d, error: (summary && summary.reason) || 'no answer from any provider' };
            }
            return {
                index: d.index,
                path: d.path,
                address: d.address,
                confirmed: summary.confirmed,
                unconfirmed: summary.unconfirmed,
                totalReceived: summary.totalReceived,
                totalSent: summary.totalSent,
                txCount: summary.txCount,
                stale: !!summary.stale,
                cachedAt: summary.cachedAt || null,
            };
        });

        for (const entry of entries) {
            addresses.push(entry);
            if (entry.error) {
                errors += 1;
                // Unknown, not empty. Leave the gap counter alone so a failure cannot
                // shorten the scan.
                continue;
            }
            if (isUsed(entry)) consecutiveUnused = 0;
            else consecutiveUnused += 1;
        }

        // Defensive: a window that produced nothing would otherwise spin forever.
        if (derived.length === 0) break;
        index += derived.length;

        if (errors >= 8) {
            incompleteReason = `${errors} addresses could not be checked — the block explorers are not answering.`;
            break;
        }
        if (deadline !== null && Date.now() > deadline) {
            incompleteReason = 'The block explorers were too slow to finish checking every address in time.';
            break;
        }
        if (consecutiveUnused >= gapLimit && index >= minIndices) break;
    }

    // Three separate ways a scan can be less than the whole truth. All of them must set
    // the flag: a total that quietly omits addresses is worse than no total at all.
    if (!incompleteReason && index >= maxIndices && consecutiveUnused < gapLimit) {
        incompleteReason = `Stopped at the ${maxIndices}-address limit while addresses were still in use — there may be more.`;
    }
    if (!incompleteReason && index >= maxIndices && index < minIndices) {
        // The ceiling cut the scan short before it reached the highest index this wallet
        // has actually issued, so a funded address past the ceiling would be missed.
        incompleteReason = `Stopped at the ${maxIndices}-address limit, but this wallet has issued addresses up to index ${minIndices - 1}. Raise WALLET_MAX_SCAN_INDICES.`;
    }
    if (!incompleteReason && errors > 0) {
        // Below the abort threshold, but still unread. The total omits these.
        incompleteReason = `${errors} address${errors > 1 ? 'es' : ''} could not be read, so this figure may be too low.`;
    }

    return {
        addresses,
        incomplete: !!incompleteReason,
        incompleteReason,
        scanned: addresses.length,
        errors,
    };
}

/** Looks up exactly one path, with no children. */
async function scanSingle(rootNode, pathSpec, config, options = {}) {
    let address;
    try {
        address = deriveAddress(rootNode, pathSpec.path, pathSpec.type, config.NETWORK);
    } catch (error) {
        return {
            addresses: [{ index: null, path: pathSpec.path, address: null, error: `could not derive: ${error.message}` }],
            incomplete: true,
            incompleteReason: `could not derive: ${error.message}`,
            scanned: 1,
            errors: 1,
        };
    }

    const summary = await getSummary(address, config, { refresh: !!options.refresh, deadline: options.deadline ?? null });
    const entry = summary.ok
        ? {
            index: null,
            path: pathSpec.path,
            address,
            confirmed: summary.confirmed,
            unconfirmed: summary.unconfirmed,
            totalReceived: summary.totalReceived,
            totalSent: summary.totalSent,
            txCount: summary.txCount,
            stale: !!summary.stale,
            cachedAt: summary.cachedAt || null,
        }
        : { index: null, path: pathSpec.path, address, error: summary.reason };

    return {
        addresses: [entry],
        incomplete: !summary.ok,
        incompleteReason: summary.ok ? null : summary.reason,
        scanned: 1,
        errors: summary.ok ? 0 : 1,
    };
}

// --- The branches the service itself uses ---------------------------------

function accountPath(config) {
    const coinType = config.NETWORK === bitcoin.networks.bitcoin ? 0 : 1;
    return `m/84'/${coinType}'/0'`;
}

/**
 * The three branches this service writes to. Kept in one place so the wallet view and
 * the code that derives addresses cannot drift apart.
 */
function builtInBranches(config) {
    const account = accountPath(config);
    return [
        {
            id: 'receive',
            label: 'Customer payment addresses',
            path: `${account}/0`,
            type: 'p2wpkh',
            builtIn: true,
            // No top-up address is offered here. The next unused address on this branch
            // is the one the next customer will be told to pay, so the operator's own
            // money arriving there would look exactly like that customer's payment.
            noReceive: true,
            note: 'One address per order. Anything sitting here is a customer payment that has not been spent yet.',
        },
        {
            id: 'change',
            label: 'Change from published messages',
            path: `${account}/1`,
            type: 'p2wpkh',
            builtIn: true,
            note: 'What is left of each payment after the miner fee. This is the service\'s earnings.',
        },
        {
            id: 'treasury',
            label: 'Treasury (pays for the free proofs)',
            // Hardcoded coin type 0 to match TREASURY_PATH in treasury.js, which does the
            // same. On testnet the rest of the wallet would sit under coin type 1, and
            // deriving the treasury there would show a balance for an address the
            // treasury code never touches.
            path: "m/84'/0'/0'/2",
            type: 'p2wpkh',
            builtIn: true,
            // treasury.js spends from index 0 and nothing else, so topping it up must go
            // to that exact address. Offering the "next unused" address here would park
            // the money somewhere the free-proof service cannot reach.
            fixedReceiveIndex: 0,
            note: 'Funds self-paid messages, including the free proof service. Electrum cannot see this branch — it only ever scans /0 and /1.',
        },
    ];
}

// --- Saved custom branches ------------------------------------------------
// Stored as JSON in system_settings, which already exists, so no schema change is
// needed and nothing about the requests table is touched.

const WATCH_SETTING_KEY = 'wallet_watch_paths';

async function getWatchedBranches(db) {
    try {
        const row = await dbGet(db, 'SELECT value FROM system_settings WHERE key = ?', [WATCH_SETTING_KEY]);
        if (!row || !row.value) return [];
        const parsed = JSON.parse(row.value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.warn(`[Wallet] Could not read watched paths: ${error.message}`);
        return [];
    }
}

async function saveWatchedBranches(db, branches) {
    await dbRun(
        db,
        'INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)',
        [WATCH_SETTING_KEY, JSON.stringify(branches)]
    );
    // The set of branches changed, so the assembled overview is wrong now. Without this
    // a newly watched path would not appear, and a removed one would keep being counted,
    // until the cache expired on its own.
    invalidateOverview();
}

// --- Whose money is it ----------------------------------------------------

/**
 * Maps every payment address the database knows about to its order, so the wallet can
 * separate the operator's own funds from a customer payment that has not been delivered
 * or refunded yet. Those two are very different things to see in a balance.
 */
async function loadRequestIndex(db) {
    const rows = await dbAll(
        db,
        `SELECT id, address, status, requiredAmountSatoshis, paymentReceivedSatoshis,
                opReturnTxId, refundTxId, createdAt
         FROM requests`
    );
    const byAddress = new Map();
    let maxIndex = -1;
    for (const row of rows) {
        byAddress.set(row.address, {
            requestId: row.id,
            status: row.status,
            settled: !!(row.opReturnTxId || row.refundTxId),
            createdAt: row.createdAt,
        });
    }
    // The highest index this wallet has ever handed out. Taken from BOTH the requests
    // table and wallet_state, because cleanup.js deletes old unfunded request rows while
    // wallet_state keeps counting — so the table alone can understate how far the wallet
    // has gone, and the scan would stop short of a funded address.
    const indexRow = await dbGet(db, 'SELECT MAX("index") AS maxIndex FROM requests');
    if (indexRow && indexRow.maxIndex !== null && indexRow.maxIndex !== undefined) {
        maxIndex = indexRow.maxIndex;
    }
    try {
        const stateRow = await dbGet(db, 'SELECT last_derived_index FROM wallet_state WHERE id = 1');
        if (stateRow && Number.isInteger(stateRow.last_derived_index)) {
            maxIndex = Math.max(maxIndex, stateRow.last_derived_index);
        }
    } catch (error) {
        console.warn(`[Wallet] Could not read wallet_state: ${error.message}`);
    }
    return { byAddress, maxRequestIndex: maxIndex };
}

function summariseBranch(branch, scan, requestIndex) {
    let confirmed = 0;
    let unconfirmed = 0;
    let customerFunds = 0;
    let staleCount = 0;
    // Tracked here, over the UNFILTERED list. A stale zero balance is dropped from the
    // displayed rows, so deriving this from the filtered list later would report
    // staleCount > 0 with no age to go with it.
    let oldestStale = null;
    const funded = [];

    for (const entry of scan.addresses) {
        if (entry.error || !entry.address) continue;
        if (entry.stale) {
            staleCount += 1;
            if (entry.cachedAt && (oldestStale === null || entry.cachedAt < oldestStale)) oldestStale = entry.cachedAt;
        }
        const linked = requestIndex.byAddress.get(entry.address) || null;
        entry.request = linked;
        confirmed += entry.confirmed;
        unconfirmed += entry.unconfirmed;
        // An unsettled order's address still holds the customer's money, not ours.
        if (linked && !linked.settled) {
            customerFunds += entry.confirmed + entry.unconfirmed;
        }
        if (entry.confirmed !== 0 || entry.unconfirmed !== 0) funded.push(entry);
    }

    const nextUnused = scan.addresses.find((a) => !a.error && a.address && !isUsed(a)) || null;

    // A branch with a fixed receive index has exactly one correct top-up address, and
    // falling back to a different one would send money somewhere the service never
    // spends from. So the error flag is deliberately ignored here: a failed *balance*
    // lookup says nothing about the address itself, which is derived locally and is
    // still correct. Only a derivation failure (no address at all) leaves it unset, and
    // in that case no address is offered rather than the wrong one.
    const hasFixedIndex = branch.fixedReceiveIndex !== undefined && branch.fixedReceiveIndex !== null;
    const fixedReceive = hasFixedIndex
        ? (scan.addresses.find((a) => a.index === branch.fixedReceiveIndex && a.address) || null)
        : null;

    return {
        ...branch,
        confirmed,
        unconfirmed,
        total: confirmed + unconfirmed,
        customerFunds,
        usedCount: scan.addresses.filter((a) => !a.error && isUsed(a)).length,
        fundedCount: funded.length,
        scanned: scan.scanned,
        errors: scan.errors,
        staleCount,
        incomplete: scan.incomplete,
        incompleteReason: scan.incompleteReason,
        // Only addresses worth showing: anything holding money, plus anything with a
        // history. A hundred untouched addresses are noise.
        addresses: scan.addresses.filter((a) => a.error || a.address && (isUsed(a) || a.confirmed !== 0 || a.unconfirmed !== 0)),
        nextUnusedAddress: nextUnused,
        // Where the operator should send money to top this branch up.
        //
        // A fixed-index branch offers that address and nothing else — never a fallback.
        // Branches with noReceive offer nothing at all: the customer-payment branch's
        // next unused address is the one about to be quoted to the next customer, and
        // the operator's own money landing there would be indistinguishable from a
        // payment for that order.
        receiveAddress: hasFixedIndex ? fixedReceive : (branch.noReceive ? null : nextUnused),
        receiveIsFixed: hasFixedIndex && !!fixedReceive,
        oldestStaleAt: oldestStale,
    };
}

// --- Price ----------------------------------------------------------------

// Deliberately not mempool.space: that host is not reachable from this machine at all
// (the connection times out), which is also why it sits second among the block explorers.
const PRICE_SOURCES = [
    {
        name: 'blockchain.info',
        url: 'https://blockchain.info/ticker',
        parse: (d) => ({ eur: d?.EUR?.last ?? null, usd: d?.USD?.last ?? null }),
    },
    {
        name: 'coingecko',
        url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur,usd',
        parse: (d) => ({ eur: d?.bitcoin?.eur ?? null, usd: d?.bitcoin?.usd ?? null }),
    },
];

let priceCache = null;
async function getPrice() {
    const TTL = 5 * 60 * 1000;
    if (priceCache && Date.now() - priceCache.at < TTL) return priceCache.value;

    const axios = require('axios');
    for (const source of PRICE_SOURCES) {
        try {
            const res = await axios.get(source.url, { timeout: 8000 });
            const parsed = source.parse(res.data);
            if (parsed.eur || parsed.usd) {
                const value = { ...parsed, source: source.name };
                priceCache = { at: Date.now(), value };
                return value;
            }
        } catch (error) {
            console.warn(`[Wallet] Price lookup via ${source.name} failed: ${error.message}`);
        }
    }
    // Purely decorative — a missing price must never fail the wallet view.
    return priceCache ? priceCache.value : { eur: null, usd: null, source: null };
}

// --- The whole picture ----------------------------------------------------

/**
 * Scans every built-in branch plus every saved custom one and adds up the result.
 */
// The last completed overview, reused so the panel does not re-scan on every visit.
//
// The per-address cache alone is not enough. A failed lookup deliberately does NOT
// refresh its timestamp — pretending stale data is current is the thing this must never
// do — so while the explorers are unhappy every single request would retry every single
// address and burn the full time budget. Caching the assembled result puts a floor on how
// often that can happen. An incomplete result is held for much less time, so a temporary
// outage is retried soon rather than sticking around for the full ten minutes.
let overviewCache = null;
const INCOMPLETE_REUSE_MS = 60 * 1000;

function invalidateOverview() {
    overviewCache = null;
}

async function scanWallet(db, rootNode, config, options = {}) {
    const refresh = !!options.refresh;

    if (!refresh && overviewCache) {
        const maxAge = overviewCache.value.incomplete ? INCOMPLETE_REUSE_MS : config.WALLET_CACHE_TTL_MS;
        const age = Date.now() - overviewCache.at;
        if (age < maxAge) {
            return { ...overviewCache.value, servedFromCache: true, checkedAt: new Date(overviewCache.at).toISOString() };
        }
    }

    await ensureCacheLoaded(db);
    // Note: a refresh forces every address to be re-fetched, but the cache is NOT
    // cleared. If the re-fetch fails, the previous figure is still there to fall back on,
    // which is the whole point of keeping it.

    const requestIndex = await loadRequestIndex(db);
    const watched = await getWatchedBranches(db);
    const branches = [...builtInBranches(config), ...watched];

    // One budget shared by every branch, so the endpoint's total time is bounded no
    // matter how many paths are being watched. A deliberate Refresh gets the longer one.
    const budget = refresh
        ? (config.WALLET_REFRESH_BUDGET_MS || 60000)
        : (config.WALLET_SCAN_BUDGET_MS || 25000);
    const deadline = Date.now() + budget;

    const scanned = [];
    for (const branch of branches) {
        // The receive branch is scanned at least as far as the highest index ever issued.
        // Orders can leave gaps wider than the gap limit — an abandoned order never pays,
        // so its address stays untouched — and stopping on the gap alone would step
        // straight past a later address that does hold a customer's money.
        const minIndices = branch.id === 'receive' ? requestIndex.maxRequestIndex + 2 : 0;
        const scan = branch.mode === 'single'
            ? await scanSingle(rootNode, branch, config, { refresh, deadline })
            : await scanBranch(rootNode, branch, config, { refresh, minIndices, deadline });
        scanned.push(summariseBranch(branch, scan, requestIndex));
    }

    const totals = scanned.reduce(
        (acc, b) => ({
            confirmed: acc.confirmed + b.confirmed,
            unconfirmed: acc.unconfirmed + b.unconfirmed,
            customerFunds: acc.customerFunds + b.customerFunds,
        }),
        { confirmed: 0, unconfirmed: 0, customerFunds: 0 }
    );

    const price = await getPrice();
    await persistCache(db);

    const staleCount = scanned.reduce((sum, b) => sum + (b.staleCount || 0), 0);
    // The oldest figure contributing to the total, so the panel can say how far behind
    // the number might be rather than presenting it as current.
    const oldestStale = scanned.reduce(
        (oldest, b) => (b.oldestStaleAt && (oldest === null || b.oldestStaleAt < oldest) ? b.oldestStaleAt : oldest),
        null
    );

    const result = {
        totals: {
            ...totals,
            total: totals.confirmed + totals.unconfirmed,
            yours: totals.confirmed + totals.unconfirmed - totals.customerFunds,
        },
        branches: scanned,
        incomplete: scanned.some((b) => b.incomplete),
        staleCount,
        oldestStaleAt: oldestStale ? new Date(oldestStale).toISOString() : null,
        price,
        account: accountPath(config),
        generatedAt: new Date().toISOString(),
    };
    overviewCache = { at: Date.now(), value: result };
    return { ...result, servedFromCache: false, checkedAt: result.generatedAt };
}

module.exports = {
    ADDRESS_TYPES,
    WATCH_SETTING_KEY,
    deriveAddress,
    normalizePath,
    scanBranch,
    scanSingle,
    scanWallet,
    summariseBranch,
    builtInBranches,
    getWatchedBranches,
    saveWatchedBranches,
    loadRequestIndex,
    clearSummaryCache,
    invalidateOverview,
    ensureCacheLoaded,
    persistCache,
    isUsed,
    accountPath,
};
