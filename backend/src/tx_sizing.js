// backend/src/tx_sizing.js
//
// Output sizes and dust thresholds derived from the actual scriptPubKey, rather than
// assumed from one address type.
//
// Every fee estimate here used to add a flat 31 vBytes for the recipient output — the
// size of a P2WPKH output. A P2WSH output is 43. On 2026-08-06 four paid orders to a
// P2WSH address failed on that 12-byte gap: two were priced below the minimum relay fee
// and caught before broadcast, two were built and rejected by the network as dust. All
// four were refunded, and the customer paid the refund fees for our arithmetic.

const bitcoin = require('bitcoinjs-lib');

/**
 * The serialised size of a CompactSize integer.
 *
 * This used to be assumed to be 1, which was true while the only outputs measured here
 * were recipient scripts (34 bytes at most). The OP_RETURN output is not: a payload big
 * enough to hold an image pushes its script past 252 bytes and the varint becomes three.
 */
function varIntVBytes(n) {
    if (n < 253) return 1;
    if (n < 0x10000) return 3;
    if (n < 0x100000000) return 5;
    return 9;
}

/**
 * The serialised size of a transaction output: an 8-byte value, a varint script length,
 * then the script.
 */
function outputVBytes(script) {
    return 8 + varIntVBytes(script.length) + script.length;
}

/**
 * The scriptPubKey size of an OP_RETURN carrying `dataLength` bytes:
 * OP_RETURN, then a push whose prefix grows with the payload.
 *
 *   <= 75    direct push          1 byte
 *   <= 255   OP_PUSHDATA1 + len   2 bytes
 *   larger   OP_PUSHDATA2 + len   3 bytes
 */
function opReturnScriptVBytes(dataLength) {
    const pushPrefix = dataLength <= 75 ? 1 : dataLength <= 255 ? 2 : 3;
    return 1 + pushPrefix + dataLength;
}

/**
 * The full output size for an OP_RETURN carrying `dataLength` bytes.
 *
 * THE SINGLE SOURCE OF TRUTH for this number. queue.js quotes from it and
 * op_return_creator.js builds from it, and the two drifting apart is how a customer pays
 * for a transaction we cannot broadcast.
 *
 * Both used to hand-roll it: queue.js as `11 + messageBytes` and the builder as
 * `script.length + 9`. Both assume a one-byte push prefix and a one-byte varint, so both
 * under-count for any payload over 75 bytes — the queue by up to 4 vBytes, the builder by
 * 2. At the 64-byte messages this service had actually published, both were exactly right,
 * which is precisely the shape of the 2026-08-06 bug: an assumption that held for the
 * common case and silently stopped holding for a new one.
 *
 * Checked against bitcoinjs `payments.embed` at 64, 75, 76, 252, 255, 256, 520, 1000,
 * 8000 and 10000 bytes.
 */
function opReturnOutputVBytes(dataLength) {
    const scriptLength = opReturnScriptVBytes(dataLength);
    return 8 + varIntVBytes(scriptLength) + scriptLength;
}

function outputVBytesForAddress(address, network) {
    return outputVBytes(bitcoin.address.toOutputScript(address, network));
}

// Bitcoin Core's GetDustThreshold charges the default -dustrelayfee (3000 sat/kvB, i.e.
// 3 sat/vB) against the cost of creating an output plus the cost of spending it again.
// Core discounts the witness portion of that spend, which puts a P2WSH output at 330
// sats. BlockCypher does not apply the discount, and it is first in the broadcast order:
// on 2026-08-06 it rejected a 548-sat P2WSH output as "non standard: dust".
//
// So we measure against the stricter, undiscounted rule. A threshold that clears every
// provider is the only one that keeps the promise never to take money for a transaction
// we cannot broadcast.
const DUST_RELAY_SAT_PER_VBYTE = 3;
const UNDISCOUNTED_SPEND_VBYTES = 32 + 4 + 1 + 107 + 4; // prevout, sequence, scriptSig

function dustThresholdForScript(script) {
    return DUST_RELAY_SAT_PER_VBYTE * (outputVBytes(script) + UNDISCOUNTED_SPEND_VBYTES);
}

/**
 * The smallest amount we are willing to send to a given script: the stricter of that
 * script's own dust threshold and the service-wide floor.
 *
 * Flooring at DUST_LIMIT_SATS keeps this strictly a tightening. The undiscounted formula
 * puts P2WPKH at 537 and P2SH at 540 — below the 546 the service has always published —
 * and relaxing a limit that is not causing trouble buys nothing. P2WSH and P2TR come out
 * at 573, which is the case that needed raising.
 *
 *   P2PKH 546 | P2SH 546 | P2WPKH 546 | P2WSH 573 | P2TR 573
 */
function dustLimitForScript(script, config) {
    return Math.max(config.DUST_LIMIT_SATS, dustThresholdForScript(script));
}

function dustLimitForAddress(address, network, config) {
    return dustLimitForScript(bitcoin.address.toOutputScript(address, network), config);
}

module.exports = {
    varIntVBytes,
    outputVBytes,
    opReturnScriptVBytes,
    opReturnOutputVBytes,
    outputVBytesForAddress,
    dustThresholdForScript,
    dustLimitForScript,
    dustLimitForAddress,
};
