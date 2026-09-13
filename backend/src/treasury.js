// backend/src/treasury.js
//
// Self-funded OP_RETURN transactions, paid for out of the treasury at m/84'/0'/0'/2/0.
//
// This began as a convenience path for the operator's own free proofs, where the only
// money at risk was the operator's and a failure meant trying again by hand. It is being
// made ready to carry customer orders: when a customer pays over a rail that produces no
// spendable UTXO — Lightning — the message still has to reach the chain, and the only
// wallet that can pay for it is this one.
//
// That changes what this file has to survive. A free proof that fails is an inconvenience;
// a paid order that fails is money taken for a message nobody published. Everything below
// exists because op_return_creator.js learned it the expensive way first.
//
// The treasury is a hot wallet. Its key sits in the same process as the one that spends
// it, one address holds the whole balance, and nothing here can un-spend a transaction.
// Guard rails are therefore stated as refusals, not as warnings.

const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const appConfig = require('./config');
const chainProviders = require('./chain_providers');
const txSizing = require('./tx_sizing');
const payload = require('./payload');
// The builder backstop, taken from the module that owns it rather than restated. A
// second copy of this number is a second thing to forget: routes/admin.js clamps the
// configurable limits against this same constant so a settings value can never be quoted
// to a customer and then refused after they have paid.
const { MAX_ON_CHAIN_PAYLOAD_BYTES } = require('./op_return_creator');

// Dedicated treasury path — never overlaps with user request paths (m/84'/0'/0'/0/index)
// or with the change branch (m/84'/0'/0'/1/index). wallet_scan.js hardcodes this same
// path with fixedReceiveIndex 0, because a "next unused" address would be money this
// service cannot reach.
const TREASURY_PATH = "m/84'/0'/0'/2/0";

/**
 * Failure reasons inherent to the request itself. Retrying them unchanged can never
 * succeed. Everything not in this set is transient: a provider outage, a treasury that
 * needs topping up, an unconfirmed chain that a block will clear.
 *
 * The distinction is the caller's whole decision. A permanent failure means stop and
 * involve a human; a transient one means the reconcile pass should try again.
 */
const PERMANENT_FAILURES = new Set([
    'invalid_message',
    'invalid_target_address',
    'exceeds_max_spend',
    'signature_validation_failed',
    'fee_below_relay_minimum',
    'broadcast_rejected',
    // Two different messages under one request id. Retrying cannot resolve which one the
    // caller meant, and guessing publishes something nobody asked for, permanently.
    'idempotency_key_reused',
]);

function failure(reason, detail) {
    const permanent = PERMANENT_FAILURES.has(reason);
    console.error(`[Treasury] FAILED (${reason}, permanent=${permanent}): ${detail}`);
    return { ok: false, reason, detail: detail || null, permanent };
}

/**
 * Derives the treasury P2WPKH address from the HD wallet root node.
 */
function getTreasuryAddress(rootNode, network) {
    const node = rootNode.derivePath(TREASURY_PATH);
    const pubkey = Buffer.from(node.publicKey);
    const { address } = bitcoin.payments.p2wpkh({ pubkey, network });
    return address;
}

// --- What we know that the providers do not --------------------------------
//
// A block explorer's idea of which outputs are unspent lags our own by however long it
// takes a transaction to propagate and be indexed. Two treasury spends a few seconds
// apart therefore both see the same UTXO as available, and the second one builds a
// transaction that conflicts with the first: same input, different output set. Only one
// of them can ever confirm, so the second message is simply never published.
//
// This is not hypothetical for a Lightning-funded service. Invoices settle in under a
// second and two customers paying at once is an ordinary Tuesday, where two customers
// paying on-chain in the same block is not.
//
// So the process keeps its own ledger of what it has just done, and unions it with what
// the providers report:
//
//   spentOutpoints  — inputs we have successfully broadcast a spend of. Removed from the
//                     candidate set even while a provider still lists them as unspent.
//   pendingChange   — change outputs we created that no provider has indexed yet. Added
//                     to the candidate set so a second order can be published immediately
//                     rather than waiting for a block.
//
// Both are memory only and both are deliberately allowed to be lost. A restart drops back
// to the providers' view, which is stale but never wrong in the dangerous direction: it
// under-reports what we can spend, so the worst case is a transient "treasury has no
// spendable funds" that clears when the last transaction confirms.
const spentOutpoints = new Map(); // "txid:vout" -> recorded at (epoch ms)
const pendingChange = new Map();  // "txid:vout" -> { txId, vout, value, depth, at }

// How long a ledger entry is trusted. Long enough to cover a mempool backlog at the 2
// sat/vB floor, short enough that a transaction dropped from every mempool eventually
// stops being counted as money we have. Both maps are pruned on every spend.
const LEDGER_TTL_MS = 12 * 60 * 60 * 1000;

// Transactions we signed and tried to broadcast but never got a clean answer for, keyed
// by the caller's own request id.
//
// This exists because the obvious reasoning about retries is WRONG. Selection is
// deterministic, so it is tempting to say a lost broadcast response is harmless: the
// retry rebuilds the identical transaction and the provider answers "already known".
// That holds only while the chain's view is unchanged — and if the broadcast actually
// landed, the chain's view is precisely what changed. The retry then reads the input as
// spent, finds the change output instead, and builds a DIFFERENT transaction carrying the
// same message. Both confirm. The message is published twice and the treasury pays two
// fees: about 500 sats for text, about 40,000 for a 20,000-byte image at the floor.
//
// So a retry re-broadcasts the bytes it already signed rather than building new ones. A
// caller that supplies no id gets no protection, which is why the Lightning work must
// pass one — and why the durable version of this is a row written before the broadcast,
// not a map that a restart forgets.
const attemptedSpends = new Map(); // request id -> { txHex, txId, fingerprint, record, result, at }

// Bitcoin Core's default mempool policy accepts at most 25 unconfirmed ancestors (and
// 101 kvB of them). Publishing stops well short of that: the deeper the chain, the more
// of the operator's money is riding on one unconfirmed parent, and at the 2 sat/vB floor
// a chain that long can sit for hours.
const MAX_UNCONFIRMED_DEPTH = 10;

// Never build a transaction with more inputs than this. Each one costs 68 vBytes, so the
// cap is really a cap on how much a fragmented treasury can quietly inflate a fee.
const MAX_INPUTS = 10;

function outpointKey(txId, vout) {
    return `${txId}:${vout}`;
}

function pruneLedger(now = Date.now()) {
    for (const [key, at] of spentOutpoints) {
        if (now - at > LEDGER_TTL_MS) spentOutpoints.delete(key);
    }
    for (const [key, entry] of pendingChange) {
        if (now - entry.at > LEDGER_TTL_MS) pendingChange.delete(key);
    }
    for (const [key, entry] of attemptedSpends) {
        if (now - entry.at > LEDGER_TTL_MS) attemptedSpends.delete(key);
    }
}

/** What makes two calls "the same request": the same bytes, to the same place, at the same price. */
function requestFingerprint({ message, payloadKind, targetAddress, feeRate, amountToSend }) {
    return crypto.createHash('sha256')
        .update(String(message ?? '')).update('\u0000')
        .update(String(payloadKind ?? '')).update('\u0000')
        .update(String(targetAddress ?? '')).update('\u0000')
        .update(String(feeRate ?? '')).update('\u0000')
        .update(String(amountToSend ?? ''))
        .digest('hex');
}

/**
 * Records a broadcast that actually happened: its inputs are gone, and its change is
 * spendable by the next transaction before any provider has indexed it.
 *
 * Called ONLY after a provider has accepted the transaction. A broadcast that failed
 * must leave the ledger untouched — see the note on determinism in
 * createSelfFundedOpReturn.
 */
function recordBroadcast({ inputs, txId, changeVout, changeValue, depth }) {
    const now = Date.now();
    for (const input of inputs) {
        spentOutpoints.set(outpointKey(input.txId, input.vout), now);
        pendingChange.delete(outpointKey(input.txId, input.vout));
    }
    if (changeVout !== null && changeValue > 0) {
        pendingChange.set(outpointKey(txId, changeVout), {
            txId, vout: changeVout, value: changeValue, depth, at: now,
        });
    }
}

// --- Reading what the treasury holds ---------------------------------------

/**
 * The treasury's unspent outputs, as the chain sees them.
 *
 * Esplora first, BlockCypher last, which is the opposite of the broadcast order and
 * deliberate: BlockCypher's getUnspent reads only `txrefs` and so reports CONFIRMED
 * outputs only (chain_providers.js), while the Esplora hosts report mempool outputs too.
 * A treasury that has just published is holding its balance in an unconfirmed change
 * output, and a view that cannot see it reports a funded wallet as empty.
 *
 * Cooldown reordering is on, because this is a read. It is never on for the broadcast —
 * a host being slow must not get to decide which host declares a transaction invalid.
 *
 * @returns {Promise<{ok: true, utxos: object[], provider: string} | {ok: false, reason: string}>}
 */
async function fetchTreasuryUtxos(address, config) {
    const result = await chainProviders.getUnspent(address, config, {
        onlyProviders: ['blockstream.info', 'mempool.space', 'blockcypher'],
        useCooldown: true,
    });
    if (!result.ok) return { ok: false, reason: result.reason };

    const utxos = (result.utxos || []).map((u) => ({
        txId: u.txId,
        vout: u.vout,
        value: u.value,
        confirmed: (u.confirmations || 0) >= 1,
    }));
    console.log(`[Treasury] ${utxos.length} UTXO(s) via ${result.provider}: `
        + `${utxos.filter((u) => u.confirmed).length} confirmed, `
        + `${utxos.filter((u) => !u.confirmed).length} unconfirmed, `
        + `${utxos.reduce((s, u) => s + u.value, 0)} sats total.`);
    return { ok: true, utxos, provider: result.provider };
}

/**
 * The candidate set a spend may draw on: what the chain reports, minus what this process
 * has already spent, plus the change it has created and the chain has not yet seen.
 *
 * Ordering is deterministic and confirmed-first. Determinism matters more than it looks:
 * if a broadcast's HTTP response is lost after the network accepted the transaction, the
 * retry rebuilds from the same candidates in the same order, produces the byte-identical
 * transaction, and the provider answers "already known" — which the classifier reads as
 * success. Sort by anything unstable and the retry becomes a conflicting double-spend
 * instead.
 */
function buildCandidates(chainUtxos) {
    pruneLedger();

    const seen = new Set();
    const candidates = [];

    for (const u of chainUtxos) {
        const key = outpointKey(u.txId, u.vout);
        if (spentOutpoints.has(key)) continue;
        seen.add(key);
        // Once a provider indexes our own change, it reports it as just another
        // unconfirmed output — and an output we made is one we know the ancestry of. Take
        // the depth we recorded rather than the depth we would guess, or the chain we are
        // counting resets to 1 the moment the mempool catches up with us and the cap stops
        // capping anything.
        //
        // A foreign unconfirmed output (an operator top-up, say) carries an ancestor count
        // we cannot know. Treated as depth 1: optimistic, and self-correcting — if the real
        // chain is too long the broadcast is refused as "too-long-mempool-chain", which
        // classifies transient and clears with a block.
        const known = pendingChange.get(key);
        candidates.push({ ...u, depth: u.confirmed ? 0 : (known ? known.depth : 1) });
    }

    for (const [key, entry] of pendingChange) {
        if (spentOutpoints.has(key) || seen.has(key)) continue;
        candidates.push({
            txId: entry.txId, vout: entry.vout, value: entry.value,
            confirmed: false, depth: entry.depth,
            // Marked because these are the only candidates that might not exist. A chain
            // UTXO was reported by a provider; this one is our own optimism about a
            // transaction that may since have been evicted from every mempool. When a
            // broadcast comes back saying an input is already spent, this flag is what
            // separates "our guess was wrong" from "the chain's answer was wrong".
            fromLedger: true,
        });
    }

    return candidates.sort((a, b) => {
        if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
        if (a.depth !== b.depth) return a.depth - b.depth;
        if (a.value !== b.value) return b.value - a.value;
        if (a.txId !== b.txId) return a.txId < b.txId ? -1 : 1;
        return a.vout - b.vout;
    });
}

// --- Sizing -----------------------------------------------------------------

// Covers the half-vByte of segwit marker/flag rounding and the one-byte spread between a
// low-R and a high-R signature per input. op_return_creator.js carries the same margin
// for the same reason; this path had none at all until 2026-08-08, and it is the path
// with no customer UTXO to absorb an error.
const FEE_SAFETY_VBYTES = 4;

/**
 * The estimated vsize of a treasury transaction: overhead, N P2WPKH inputs, the OP_RETURN
 * output, an optional recipient output, and the change output back to the treasury.
 *
 * Exported so the harness can assert it against a real signed transaction. The estimate
 * must never come out below the real size — that is what the post-signing check enforces,
 * and what a customer's money would otherwise pay for.
 */
function estimateTreasuryVBytes(inputCount, payloadBytes, targetScript, { includeChange = true } = {}) {
    let vbytes = 10.5 + 68 * inputCount + txSizing.opReturnOutputVBytes(payloadBytes) + FEE_SAFETY_VBYTES;
    if (targetScript) vbytes += txSizing.outputVBytes(targetScript);
    if (includeChange) vbytes += 31; // change is always P2WPKH, back to the treasury
    return Math.ceil(vbytes);
}

/**
 * Chooses inputs largest-first until they cover the fee and the recipient output, growing
 * the fee as each input is added.
 *
 * Pure, and exported for the harness: the interesting cases (a treasury that cannot pay,
 * one that needs three inputs, one whose only funds are an unconfirmed chain too deep to
 * build on) are all decided here, before anything is signed.
 */
function selectInputs(candidates, { payloadBytes, targetScript, targetValue, feeRate }) {
    const usable = candidates.filter((c) => c.depth < MAX_UNCONFIRMED_DEPTH);

    function greedy(ordered) {
        const chosen = [];
        let total = 0;
        for (const candidate of ordered) {
            if (chosen.length >= MAX_INPUTS) break;
            chosen.push(candidate);
            total += candidate.value;
            const vbytes = estimateTreasuryVBytes(chosen.length, payloadBytes, targetScript);
            const fee = vbytes * feeRate;
            if (total >= fee + targetValue) return { ok: true, chosen, total, fee, vbytes };
        }
        return { ok: false, chosen, total };
    }

    // First pass in the candidate order, which prefers confirmed money and shallow chains.
    const preferred = greedy(usable);
    if (preferred.ok) return preferred;

    // Second pass by value alone. The input cap can end the first pass with a covering
    // output still unexamined: anyone can send ten 294-sat outputs to the treasury address
    // — it is the reused change address of every treasury spend, so it is on chain — and
    // those ten confirmed crumbs then sort ahead of an unconfirmed change output holding
    // the entire balance. The greedy pass spends all ten slots on 2,940 sats and gives up,
    // reporting an unfunded treasury while the address holds millions. For about 3,000
    // sats an attacker buys one publication per block; without Lightning that is an
    // annoyance, with it a paid order that fails on money the service has.
    //
    // Ordering by value is still deterministic, which the lost-response retry depends on.
    const byValue = [...usable].sort((a, b) => {
        if (a.value !== b.value) return b.value - a.value;
        if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
        if (a.depth !== b.depth) return a.depth - b.depth;
        if (a.txId !== b.txId) return a.txId < b.txId ? -1 : 1;
        return a.vout - b.vout;
    });
    const byLargest = greedy(byValue);
    if (byLargest.ok) return byLargest;

    const blockedByDepth = candidates.length > 0 && usable.length === 0;
    return {
        ok: false,
        chosen: preferred.chosen,
        total: preferred.total,
        reason: blockedByDepth ? 'unconfirmed_chain_too_deep' : 'insufficient_treasury_funds',
        // Everything the address actually holds that we could have spent — not the value
        // of whichever inputs the search happened to pick. Telling an operator to top up a
        // treasury that is funded sends them looking in the wrong place entirely.
        spendableTotal: usable.reduce((sum, c) => sum + c.value, 0),
        candidateCount: usable.length,
        // What it would have needed, for a message a human can act on.
        needed: estimateTreasuryVBytes(Math.max(1, preferred.chosen.length), payloadBytes, targetScript)
            * feeRate + targetValue,
    };
}

// --- One spend at a time ----------------------------------------------------
//
// Everything from "which outputs are unspent" to "the broadcast was accepted" runs under
// this lock. Reading the candidate set outside it is exactly the race the ledger exists
// to close: two callers would both read, both choose the same input, and the second
// transaction would be a conflicting double-spend of the first.
//
// The lock is per process, which is all the container has (one node process, one
// container in docker-compose.yml). If this service is ever run as more than one
// instance against the same seed, this is the thing that breaks first, and the fix is a
// database claim rather than a promise chain.
let queueTail = Promise.resolve();

function withTreasuryLock(fn) {
    const result = queueTail.then(fn);
    // The queue must survive a rejection, or one failed spend deadlocks every later one.
    queueTail = result.then(() => {}, () => {});
    return result;
}

/**
 * Creates, signs and broadcasts a self-funded OP_RETURN transaction. Change returns to
 * the treasury address.
 *
 * Returns a classified result rather than throwing, so a caller can tell "top the
 * treasury up" from "this message can never be published" without parsing an error
 * string. This mirrors op_return_creator.js, which the reconcile pass already knows how
 * to drive.
 *
 * Takes a request-shaped object rather than a list of positional arguments, the same
 * shape op_return_creator.js's createOpReturnTransaction takes, so a caller that has a
 * row in hand can drive either builder without reshuffling its fields.
 *
 * @param {{message: string, payloadKind?: string, targetAddress?: string,
 *   feeRate?: number, amountToSend?: number, id?: string}} request
 * @returns {Promise<{ok: true, txId, txHex, treasuryAddress, fee, pricedFee, vBytes,
 *   inputValue, changeValue, inputCount, changePath, provider, alreadyBroadcast}
 *   | {ok: false, reason, detail, permanent}>}
 */
async function createSelfFundedOpReturn(request, rootNode, config) {
    return withTreasuryLock(() => buildAndBroadcast(request || {}, rootNode, config));
}

async function buildAndBroadcast(request, rootNode, config) {
    const { message, payloadKind, targetAddress, feeRate, amountToSend } = request;
    // Module defaults, overridden by whatever the caller passed. treasury.js used to read
    // NETWORK from the argument and DUST_LIMIT_SATS/MIN_EFFECTIVE_FEE_RATE from the module
    // singleton, so a caller supplying a config got real values for half its arithmetic
    // and its own for the other half. Merging removes the split rather than documenting it.
    const cfg = { ...appConfig, ...(config || {}) };
    const network = cfg.NETWORK;
    const treasuryAddress = getTreasuryAddress(rootNode, network);

    // --- Have we already signed this? --------------------------------------
    // See the note on attemptedSpends. A retry after an unclear broadcast must re-send the
    // bytes it signed, never build fresh ones from a chain view that the first attempt may
    // itself have changed.
    pruneLedger();
    const fingerprint = requestFingerprint(request);
    const prior = request.id ? attemptedSpends.get(request.id) : null;
    if (prior) {
        if (prior.fingerprint !== fingerprint) {
            // The same id carrying different content is an upstream bug, and the two
            // possible responses are "publish both" or "publish neither". Neither is right,
            // but only one of them is reversible.
            return failure('idempotency_key_reused',
                `request ${request.id} was already signed with different content; refusing to publish a second transaction under the same id`);
        }
        console.log(`[Treasury] Re-broadcasting the transaction already signed for ${request.id} (${prior.txId}) rather than building a new one.`);
        const again = await chainProviders.broadcastTransaction(prior.txHex, config, prior.txId);
        if (again.ok) {
            recordBroadcast(prior.record);
            attemptedSpends.delete(request.id);
            return { ...prior.result, provider: again.provider, alreadyBroadcast: !!again.alreadyBroadcast };
        }
        if (again.inputsSpent) {
            // Something else took an input, so those bytes can never confirm. Drop them and
            // let the next attempt build against a fresh read.
            attemptedSpends.delete(request.id);
            return failure('treasury_inputs_stale',
                `${again.reason} (the transaction signed earlier for ${request.id} can no longer confirm; it will be rebuilt)`);
        }
        return failure(
            again.permanent ? 'broadcast_rejected' : 'broadcast_unavailable',
            `${again.reason} (re-broadcasting ${prior.txId})`
        );
    }

    // --- The payload -------------------------------------------------------
    // Through payload.js, exactly as op_return_creator.js does it, and for the reason the
    // top of CLAUDE.md is about: for an image row `message` holds BASE64, and the chain
    // must get the decoded bytes. Embedding the stored string would publish base64 ASCII
    // instead of a picture and price it a third too high — the same stored-length-versus
    // -on-chain-length inversion, in the one builder that had never been taught the
    // difference.
    //
    // validate() is called and not just decode(): it is what enforces that the bytes match
    // the media type they declare. Nothing else on this path enforces it, and a row whose
    // payloadKind disagrees with its bytes reaches the wall and the admin panel, both of
    // which build a `data:` URL from the DECLARED kind.
    const payloadCheck = payload.validate(message, payloadKind, {
        maxTextBytes: MAX_ON_CHAIN_PAYLOAD_BYTES,
        maxImageBytes: MAX_ON_CHAIN_PAYLOAD_BYTES,
    });
    if (!payloadCheck.ok) {
        return failure('invalid_message', payloadCheck.error);
    }
    let payloadBuffer;
    try {
        payloadBuffer = payload.decode(message, payloadKind);
    } catch (e) {
        return failure('invalid_message', `payload did not decode: ${e.message}`);
    }
    const opReturnOutput = bitcoin.payments.embed({ data: [payloadBuffer] });

    // --- The recipient -----------------------------------------------------
    // Resolved before anything is priced: both the fee and the dust limit depend on the
    // script this produces.
    let targetScript = null;
    if (targetAddress) {
        try {
            targetScript = bitcoin.address.toOutputScript(targetAddress, network);
        } catch (e) {
            return failure('invalid_target_address', `${targetAddress}: ${e.message}`);
        }
    }

    // A recipient output below the dust limit makes the whole transaction non-standard.
    // Intake refuses those, but clamp here too: this function is also reachable from the
    // internal API, and the limit belongs to the recipient's own script type — a flat 546
    // passed a 548-sat P2WSH output straight through to BlockCypher, which wants 573.
    let targetValue = 0;
    if (targetScript && amountToSend && amountToSend > 0) {
        const recipientDustLimit = txSizing.dustLimitForScript(targetScript, appConfig);
        targetValue = Math.max(amountToSend, recipientDustLimit);
        if (targetValue !== amountToSend) {
            console.warn(`[Treasury] Raised sub-dust recipient amount ${amountToSend} to ${recipientDustLimit} (the dust limit for ${targetAddress}).`);
        }
    }

    // --- The fee rate ------------------------------------------------------
    // Never build below the effective floor: a transaction sitting exactly on the minimum
    // relay fee is rejected as non-standard, which is why the floor is 2 and not 1.
    const requestedFeeRate = feeRate || cfg.DEFAULT_FEE_RATE;
    const effectiveFeeRate = Math.max(requestedFeeRate, cfg.MIN_EFFECTIVE_FEE_RATE);
    if (effectiveFeeRate !== requestedFeeRate) {
        console.warn(`[Treasury] Raised fee rate ${requestedFeeRate} to the ${effectiveFeeRate} sat/vB floor.`);
    }

    // --- What we can spend -------------------------------------------------
    // op_return_creator.js pays a bare targetAddress the dust limit out of the service's
    // change; this path builds no output at all without an amount. That divergence is
    // deliberate here — this is the operator's own money, and paying 546 sats to an
    // address nobody asked to fund is not a default worth having — but it means the
    // recipient output must only be PRICED when it is going to exist, or every such call
    // over-estimates by an output it never builds.
    const recipientScriptForSizing = targetValue > 0 ? targetScript : null;

    const chainUtxos = await fetchTreasuryUtxos(treasuryAddress, cfg);
    if (!chainUtxos.ok) {
        // Not knowing what the treasury holds is a provider problem, not a bad request.
        // Reported transient so the caller retries rather than giving up on the message.
        return failure('utxo_lookup_failed', `${treasuryAddress}: ${chainUtxos.reason}`);
    }

    const candidates = buildCandidates(chainUtxos.utxos);
    const selection = selectInputs(candidates, {
        payloadBytes: payloadBuffer.length, targetScript: recipientScriptForSizing, targetValue, feeRate: effectiveFeeRate,
    });

    if (!selection.ok) {
        if (selection.reason === 'unconfirmed_chain_too_deep') {
            return failure('unconfirmed_chain_too_deep',
                `every spendable output is ${MAX_UNCONFIRMED_DEPTH} or more unconfirmed transactions deep; waiting for a block`);
        }
        return failure('insufficient_treasury_funds',
            `treasury ${treasuryAddress} holds ${selection.spendableTotal} spendable sats across `
            + `${selection.candidateCount} output(s), needs about ${selection.needed}`
            + `${selection.candidateCount > MAX_INPUTS ? ` and may use at most ${MAX_INPUTS} of them` : ''}. Top it up.`);
    }

    const { chosen, total: inputValue, fee, vbytes: estimatedVBytes } = selection;

    const changeValue = inputValue - fee - targetValue;
    // selectInputs only returns ok once the inputs cover this, so a negative here means
    // the arithmetic disagrees with itself. Checked anyway: outputs exceeding inputs is
    // the one error the network cannot forgive and the one op_return_creator.js was
    // shipped without.
    if (changeValue < 0) {
        return failure('internal_error',
            `selection returned ${inputValue} sats against a ${fee + targetValue} sat requirement`);
    }

    // --- The ceiling -------------------------------------------------------
    // The most this transaction may take out of the treasury. One address holds the
    // operator's whole float and the key that spends it is in this process; a bug in a
    // quote, or a caller that should not have been trusted, must not be able to empty it
    // in a single call.
    //
    // Change too small to pay out is absorbed into the fee, so it leaves the treasury
    // too and is counted here. Measuring only the priced fee would let a transaction sit
    // up to one dust limit over the ceiling — small, but a ceiling that is approximately
    // enforced is not a ceiling.
    const absorbedChange = changeValue < cfg.DUST_LIMIT_SATS ? changeValue : 0;
    const leaving = fee + targetValue + absorbedChange;
    if (leaving > cfg.TREASURY_MAX_SPEND_SATS) {
        return failure('exceeds_max_spend',
            `this transaction would take ${leaving} sats out of the treasury `
            + `(fee ${fee} + recipient ${targetValue}${absorbedChange ? ` + ${absorbedChange} of absorbed change` : ''}), `
            + `over the ${cfg.TREASURY_MAX_SPEND_SATS} sat per-transaction ceiling`);
    }

    console.log(`[Treasury] ${chosen.length} input(s) = ${inputValue} sats | fee ${fee} `
        + `| recipient ${targetValue} | change ${changeValue} | ${payloadBuffer.length} byte payload`);

    // --- Build -------------------------------------------------------------
    const psbt = new bitcoin.Psbt({ network });
    const scriptPubKey = bitcoin.address.toOutputScript(treasuryAddress, network);

    for (const input of chosen) {
        psbt.addInput({
            hash: input.txId,
            index: input.vout,
            witnessUtxo: { script: scriptPubKey, value: input.value },
        });
    }

    psbt.addOutput({ script: opReturnOutput.output, value: 0 });
    if (targetScript && targetValue > 0) {
        psbt.addOutput({ script: targetScript, value: targetValue });
    }

    // Change back to the treasury, never to the change branch: treasury.js spends from
    // m/84'/0'/0'/2/0 and nothing else, so change sent anywhere else is money this
    // service cannot reach.
    let changeVout = null;
    if (changeValue >= cfg.DUST_LIMIT_SATS) {
        changeVout = psbt.txOutputs.length;
        psbt.addOutput({ address: treasuryAddress, value: changeValue });
    } else if (changeValue > 0) {
        console.log(`[Treasury] Change (${changeValue}) below the dust limit — absorbed into the fee.`);
    }

    // --- Sign --------------------------------------------------------------
    let treasuryNode;
    try {
        treasuryNode = rootNode.derivePath(TREASURY_PATH);
    } catch (e) {
        return failure('key_derivation_failed', `${TREASURY_PATH}: ${e.message}`);
    }

    const signer = {
        publicKey: Buffer.from(treasuryNode.publicKey),
        network,
        sign: (hash) => Buffer.from(treasuryNode.sign(hash)),
        signSchnorr: (hash) => Buffer.from(treasuryNode.signSchnorr(hash)),
    };
    const validator = (pubkey, msghash, signature) => {
        if (Buffer.compare(pubkey, Buffer.from(treasuryNode.publicKey)) !== 0) return false;
        return treasuryNode.verify(msghash, signature);
    };

    try {
        for (let i = 0; i < chosen.length; i++) {
            psbt.signInput(i, signer);
            // Checked per input rather than logged and carried on. An unsigned or wrongly
            // signed input produces a transaction the network rejects, after the estimate
            // said everything was fine.
            if (!psbt.validateSignaturesOfInput(i, validator)) {
                return failure('signature_validation_failed', `input ${i} of a ${chosen.length}-input treasury spend`);
            }
        }
        psbt.finalizeAllInputs();
    } catch (e) {
        return failure('signature_validation_failed', e.message);
    }

    const tx = psbt.extractTransaction();
    const txHex = tx.toHex();
    const txId = tx.getId();

    // Check the fee against the transaction that ACTUALLY got built, not the estimate.
    // op_return_creator.js has had this since 2026-08-06, when two orders were priced
    // below the relay minimum and only caught here.
    //
    // The fee measured here is the one the network will see — inputs minus outputs —
    // which is not always the fee that was priced: change too small to pay out is
    // absorbed, and that absorption is a fee the caller is entitled to be told about.
    // Reporting the priced number instead understates what the treasury actually spent.
    const actualVBytes = tx.virtualSize();
    const actualFee = inputValue - tx.outs.reduce((sum, o) => sum + o.value, 0);
    const actualFeeRate = actualFee / actualVBytes;
    if (actualFeeRate < cfg.MIN_EFFECTIVE_FEE_RATE) {
        return failure('fee_below_relay_minimum',
            `fee ${actualFee} sats over ${actualVBytes} vBytes is ${actualFeeRate.toFixed(3)} sat/vB, `
            + `below the ${cfg.MIN_EFFECTIVE_FEE_RATE} sat/vB floor (estimate was ${estimatedVBytes} vBytes, priced at ${fee})`);
    }
    console.log(`[Treasury] Signed ${txId} (${actualVBytes} vBytes, ${actualFee} sats, ${actualFeeRate.toFixed(2)} sat/vB)`);

    // --- Broadcast ---------------------------------------------------------
    // Through the provider chain, not straight at BlockCypher. A single host's refusal is
    // not the network's verdict: dust thresholds differ between providers, and a
    // datacarrier limit is each node operator's own setting — which is exactly how a
    // BlockCypher rejection refunded four orders on 2026-08-06 that the Esplora hosts
    // would have accepted. It also means "already known" is read as the success it is
    // rather than as a failure.
    const broadcast = await chainProviders.broadcastTransaction(txHex, config, txId);

    if (broadcast.ok) {
        const broadcastTxId = broadcast.txId || txId;
        if (request.id) attemptedSpends.delete(request.id);
        recordBroadcast({
            inputs: chosen,
            txId: broadcastTxId,
            changeVout,
            changeValue,
            depth: Math.max(0, ...chosen.map((c) => c.depth)) + 1,
        });
        if (broadcast.alreadyBroadcast) {
            console.log(`[Treasury] ${broadcastTxId} was already known — treating as broadcast.`);
        } else {
            console.log(`[Treasury] Broadcast ${broadcastTxId} via ${broadcast.provider}.`);
        }
        return {
            ok: true,
            txId: broadcastTxId,
            txHex,
            treasuryAddress,
            // The treasury spends from one fixed path and returns change to it. Recorded
            // honestly: writing a m/84'/0'/0'/1/index change path here would send
            // wallet_scan.js hunting for earnings at an index that never received anything.
            changePath: changeVout === null ? null : TREASURY_PATH,
            provider: broadcast.provider,
            fee: actualFee,
            pricedFee: fee,
            vBytes: actualVBytes,
            inputValue,
            changeValue,
            inputCount: chosen.length,
            alreadyBroadcast: !!broadcast.alreadyBroadcast,
        };
    }

    // The ledger is deliberately NOT updated on a failure: nothing is known to have been
    // spent, and marking the inputs spent would strand them until the TTL expired.
    //
    // What IS remembered is the signed transaction itself, so a retry re-sends these exact
    // bytes. Rebuilding would be safe only if the chain view were unchanged, and the one
    // case that matters — the broadcast landed and its response was lost — is exactly the
    // case where it changed. Without this, the retry sees its own change output, builds a
    // second transaction carrying the same message, and both confirm.
    if (request.id) {
        attemptedSpends.set(request.id, {
            txHex,
            txId,
            fingerprint,
            at: Date.now(),
            record: {
                inputs: chosen,
                txId,
                changeVout,
                changeValue,
                depth: Math.max(0, ...chosen.map((c) => c.depth)) + 1,
            },
            result: {
                ok: true,
                txId,
                txHex,
                treasuryAddress,
                changePath: changeVout === null ? null : TREASURY_PATH,
                fee: actualFee,
                pricedFee: fee,
                vBytes: actualVBytes,
                inputValue,
                changeValue,
                inputCount: chosen.length,
            },
        });
    }
    if (broadcast.feeTooLow) {
        return failure('fee_too_low', `${broadcast.reason} (paid ${actualFee} sats at ${effectiveFeeRate} sat/vB)`);
    }
    if (broadcast.inputsSpent) {
        // For a customer payment this means the money is gone and nothing can be refunded.
        // For the treasury it means a view of our own wallet was stale — retryable, and the
        // next pass reads the outputs again.
        //
        // Only the ledger's own optimism is dropped. The rejection names no outpoint, so an
        // earlier version marked ALL of this attempt's inputs spent — which quarantined
        // perfectly good confirmed money for the 12-hour TTL because one unrelated input had
        // moved, and then told the operator to top up a treasury the chain still showed as
        // funded. A provider's answer is evidence; our guess about an unindexed change
        // output is not, and it is the guess that gets withdrawn.
        let dropped = 0;
        for (const input of chosen) {
            if (!input.fromLedger) continue;
            pendingChange.delete(outpointKey(input.txId, input.vout));
            dropped++;
        }
        return failure('treasury_inputs_stale',
            `${broadcast.reason} (an output we believed unspent was already spent; `
            + `${dropped} unconfirmed change entr${dropped === 1 ? 'y' : 'ies'} withdrawn, re-reading the chain on the next attempt)`);
    }
    return failure(
        broadcast.permanent ? 'broadcast_rejected' : 'broadcast_unavailable',
        `${broadcast.reason} (txid would have been ${txId})`
    );
}

module.exports = {
    TREASURY_PATH,
    PERMANENT_FAILURES,
    getTreasuryAddress,
    fetchTreasuryUtxos,
    createSelfFundedOpReturn,
    // Exported for the harness: both are pure, and both decide things that must be
    // provable without a network or a wallet.
    estimateTreasuryVBytes,
    selectInputs,
    buildCandidates,
    // Test hook. The ledger is process-global by design, so a harness that exercises two
    // consecutive spends needs a way back to a known state.
    __resetLedger: () => { spentOutpoints.clear(); pendingChange.clear(); attemptedSpends.clear(); },
    __ledger: () => ({ spent: [...spentOutpoints.keys()], pending: [...pendingChange.keys()], attempted: [...attemptedSpends.keys()] }),
};
