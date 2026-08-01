// backend/src/qr.js
//
// Renders a payment QR code as an SVG.
//
// SVG rather than a bitmap so it stays sharp at any size on a phone camera, and so no
// image library or native dependency is needed on the Pi.
//
// The encoder (qrcode-generator) was checked against an independent decoder (jsQR) on a
// bech32 address and on a full BIP21 URI: encode, rasterise, decode, compare. Both round
// -tripped byte for byte. If you swap the encoder, repeat that check — a QR that scans
// but resolves to a slightly different address would send money nowhere recoverable.

const qrcode = require('qrcode-generator');

// Well under the format's real capacity. Anything longer than this is not a payment URI
// and has no business being turned into a QR code here.
const MAX_DATA_LENGTH = 512;

/**
 * Builds a BIP21 payment URI. Every wallet app understands this: scanning it fills in
 * the address, and the amount and label too when they are given.
 *
 * @param {string} address
 * @param {{amountSats?: number, label?: string, message?: string}} [opts]
 */
function buildPaymentUri(address, opts = {}) {
    const params = [];
    if (opts.amountSats && Number.isFinite(opts.amountSats) && opts.amountSats > 0) {
        // BIP21 amounts are in BTC. toFixed(8) then trimmed, so 50000 sats reads as
        // 0.0005 rather than 0.00050000.
        const btc = (opts.amountSats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
        params.push(`amount=${btc}`);
    }
    if (opts.label) params.push(`label=${encodeURIComponent(opts.label)}`);
    if (opts.message) params.push(`message=${encodeURIComponent(opts.message)}`);
    return `bitcoin:${address}${params.length ? `?${params.join('&')}` : ''}`;
}

/**
 * @param {string} data - what the camera should read, usually a BIP21 URI
 * @param {{scale?: number, margin?: number, ecc?: 'L'|'M'|'Q'|'H'}} [opts]
 * @returns {string} a standalone SVG document
 */
function toSvg(data, opts = {}) {
    const text = String(data == null ? '' : data);
    if (!text) throw new Error('nothing to encode');
    if (text.length > MAX_DATA_LENGTH) {
        throw new Error(`too long to encode (${text.length} characters, limit ${MAX_DATA_LENGTH})`);
    }

    // Clamped, and NaN falls back to the default: these come from a query string, and a
    // non-numeric value must not reach the geometry as NaN.
    const clamp = (value, fallback, min, max) => {
        const n = Number(value);
        return Math.min(Math.max(Number.isFinite(n) ? n : fallback, min), max);
    };
    const scale = clamp(opts.scale, 8, 2, 20);
    // The quiet zone is part of the spec, not decoration. Below 4 modules many scanners
    // simply fail to find the code.
    const margin = clamp(opts.margin, 4, 1, 8);
    const ecc = ['L', 'M', 'Q', 'H'].includes(opts.ecc) ? opts.ecc : 'M';

    const qr = qrcode(0, ecc); // type 0 = pick the smallest version that fits
    qr.addData(text);
    qr.make();

    const count = qr.getModuleCount();
    const size = (count + margin * 2) * scale;

    // One path holding every dark module. Far smaller than one <rect> per module, and it
    // renders identically.
    let path = '';
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            if (!qr.isDark(row, col)) continue;
            path += `M${(col + margin) * scale} ${(row + margin) * scale}h${scale}v${scale}h-${scale}z`;
        }
    }

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"`,
        ` viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img"`,
        ` aria-label="Bitcoin payment QR code">`,
        `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
        `<path d="${path}" fill="#000000"/>`,
        `</svg>`,
    ].join('');
}

module.exports = { toSvg, buildPaymentUri, MAX_DATA_LENGTH };
