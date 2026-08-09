// backend/src/payload.js
//
// What actually goes into the OP_RETURN, and how big it is.
//
// Until images existed there was one answer to both questions — `Buffer.from(message,
// 'utf8')` — and two modules hand-rolled it independently. An image cannot be stored that
// way: SQLite's TEXT column has no business holding NUL bytes or invalid UTF-8, so the
// row carries base64 and the chain carries the decoded bytes. That makes the stored
// length and the on-chain length two different numbers for the first time.
//
// THE ON-CHAIN LENGTH IS THE ONE THAT COSTS MONEY. Everything that quotes, validates or
// builds must call byteLength() here and nothing else. queue.js quoting from the stored
// length while op_return_creator.js builds from the decoded one is a 33% under-quote —
// the customer pays for 4000 bytes and we broadcast 3000, or the reverse, which is the
// failure the top of CLAUDE.md exists to prevent.
//
// The payload is stored raw, with no envelope or magic prefix of our own. WebP and JPEG
// are already self-identifying — `RIFF....WEBP` and `FFD8FF` — so anyone scanning
// OP_RETURN outputs can recognise one without a convention only we know, and a prefix
// would cost the customer real sats for nothing. `payloadKind` on the row is for our own
// rendering, not for the chain.

const KINDS = {
    TEXT: 'text',
    WEBP: 'image/webp',
    JPEG: 'image/jpeg',
};

const IMAGE_KINDS = [KINDS.WEBP, KINDS.JPEG];

/**
 * A legacy row, and every text order, has payloadKind NULL. Treat that as text rather
 * than migrating 25 rows: the column is new, so NULL means "written before this existed",
 * and that is exactly text.
 */
function normalizeKind(kind) {
    if (kind === undefined || kind === null || kind === '') return KINDS.TEXT;
    if (typeof kind !== 'string') return null;
    if (kind === KINDS.TEXT || IMAGE_KINDS.includes(kind)) return kind;
    return null;
}

function isImage(kind) {
    return IMAGE_KINDS.includes(normalizeKind(kind));
}

/**
 * Strict base64. `Buffer.from(x, 'base64')` silently discards anything it does not
 * recognise, so a payload with a stray character decodes happily to fewer bytes than the
 * caller intended — and we would quote for the string we were given and broadcast
 * something shorter. Re-encoding and comparing is the only cheap way to be sure the
 * decode was lossless.
 */
function decodeBase64Strict(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
    if (value.length % 4 !== 0) return null;
    const buf = Buffer.from(value, 'base64');
    if (buf.toString('base64') !== value) return null;
    return buf;
}

/**
 * The exact bytes this request puts on the chain.
 *
 * Throws on a payload that does not decode, deliberately. Every caller on a money path
 * has already been through validate(); reaching here with something undecodable means a
 * row was written past the guard, and silently embedding a truncated buffer would be
 * worse than failing the build.
 */
function decode(message, kind) {
    const k = normalizeKind(kind);
    if (k === KINDS.TEXT) return Buffer.from(message, 'utf8');
    const buf = decodeBase64Strict(message);
    if (!buf) throw new Error(`payload for kind ${kind} is not valid base64`);
    return buf;
}

/**
 * On-chain byte length, without allocating the buffer for the text case.
 */
function byteLength(message, kind) {
    const k = normalizeKind(kind);
    if (k === KINDS.TEXT) return Buffer.byteLength(message, 'utf8');
    return decode(message, k).length;
}

/** WebP: 'RIFF' …4 byte size… 'WEBP'. JPEG: SOI marker FFD8, then a segment marker FF. */
function sniff(buf) {
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        return KINDS.WEBP;
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return KINDS.JPEG;
    }
    return null;
}

/**
 * The intake guard. Returns the on-chain byte count, which is what gets quoted.
 *
 * @returns {{ok: true, kind: string, bytes: number} | {ok: false, error: string}}
 */
function validate(message, kind, { maxTextBytes, maxImageBytes }) {
    const k = normalizeKind(kind);
    if (k === null) {
        return { ok: false, error: `payloadKind must be one of ${[KINDS.TEXT, ...IMAGE_KINDS].join(', ')}.` };
    }

    if (typeof message !== 'string' || message.length === 0) {
        return { ok: false, error: 'Message is required and must be a string.' };
    }

    if (k === KINDS.TEXT) {
        const bytes = Buffer.byteLength(message, 'utf8');
        if (bytes > maxTextBytes) {
            return { ok: false, error: `Message must be under ${maxTextBytes} bytes.` };
        }
        return { ok: true, kind: k, bytes };
    }

    const buf = decodeBase64Strict(message);
    if (!buf) {
        return { ok: false, error: 'Image payload must be valid base64.' };
    }
    if (buf.length > maxImageBytes) {
        return { ok: false, error: `Image must be under ${maxImageBytes} bytes on-chain (this one is ${buf.length}).` };
    }

    // The declared kind has to match the bytes. A caller claiming image/webp and sending
    // something else would be rendered by the browser as whatever it actually is — the
    // wall builds a `data:` URL from the DECLARED kind, so a mismatch is the browser
    // sniffing content we did not check. Cheap to close here, so close it here.
    const sniffed = sniff(buf);
    if (sniffed === null) {
        return { ok: false, error: 'Image payload is not a recognisable WebP or JPEG.' };
    }
    if (sniffed !== k) {
        return { ok: false, error: `Image payload is ${sniffed}, but payloadKind says ${k}.` };
    }

    return { ok: true, kind: k, bytes: buf.length };
}

/**
 * How a payload is described in a Telegram alert, an event log line or the admin panel —
 * anywhere a human reads it. 4000 characters of base64 is not something to paste into a
 * notification, and the operator still needs to know an image arrived and how big it was.
 */
function describe(message, kind, bytes) {
    const k = normalizeKind(kind);
    if (k === KINDS.TEXT) return message;
    const n = bytes != null ? bytes : (() => { try { return byteLength(message, k); } catch { return null; } })();
    return `[${k === KINDS.WEBP ? 'WebP' : 'JPEG'} image${n != null ? `, ${n} bytes` : ''}]`;
}

module.exports = {
    KINDS,
    IMAGE_KINDS,
    normalizeKind,
    isImage,
    decode,
    decodeBase64Strict,
    byteLength,
    sniff,
    validate,
    describe,
};
