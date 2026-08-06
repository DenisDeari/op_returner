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
 * The serialised size of a transaction output: an 8-byte value, a varint script length,
 * then the script. Every scriptPubKey we can build is far below 253 bytes, so the varint
 * is always one byte.
 */
function outputVBytes(script) {
    return 8 + 1 + script.length;
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
    outputVBytes,
    outputVBytesForAddress,
    dustThresholdForScript,
    dustLimitForScript,
    dustLimitForAddress,
};
