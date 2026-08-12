// frontend/js/app.js
document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    let SERVICE_FEE = 2000;     // config.js SERVICE_FEE_SATS, refreshed from /api/config/limits
    const RING_CIRC = 94.25;    // 2 * pi * r, r = 15
    let MAX_BYTES = 1000;       // max_payload_size — text
    let MAX_IMAGE_BYTES = 0;    // max_image_payload_size — 0 until the server says otherwise
    // config.js MIN_FEE_RATE, refreshed from /api/config/limits. The hardcoded fallback is
    // mandatory: recalc() runs once at init, before that fetch resolves.
    let MIN_FEE = 2;

    // --- DOM ---------------------------------------------------------------
    const $ = (id) => document.getElementById(id);

    const msg = $('msg');
    const imgBtn = $('img-btn'), imgFile = $('img-file'), imgBox = $('imgbox');
    const imgPreview = $('img-preview'), imgDims = $('img-dims'), imgSize = $('img-size');
    const imgBudget = $('img-budget'), imgBudgetN = $('img-budget-n'), imgNote = $('img-note');
    const imgClear = $('img-clear'), imgOpen = $('img-open');
    const imgBudgetRow = $('img-budget-row'), imgBudgetHome = $('img-budget-home');
    const imgView = $('imgview'), imgViewX = $('imgview-x'), imgViewImg = $('imgview-img');
    const imgViewDims = $('imgview-dims'), imgViewSize = $('imgview-size');
    const imgViewSlot = $('imgview-slot'), imgViewNote = $('imgview-note');
    const ring = $('ring'), ringN = $('ring-n');
    const publicToggle = $('public-toggle');
    const addrIn = $('addr-in'), amtIn = $('amt-in'), amtNote = $('amt-note');
    const feeIn = $('fee-in'), feeN = $('fee-n');
    const feeExtra = $('fee-extra'), feeCostNote = $('fee-cost-note');
    const optBtn = $('opt-btn'), drawer = $('drawer');
    const totalBtn = $('total-btn'), totalN = $('total-n'), breakdown = $('breakdown');
    const bdNet = $('bd-net'), bdSvc = $('bd-svc'), bdRec = $('bd-rec');
    const go = $('go');
    const mine = $('mine'), ordersEl = $('orders');
    const wallEl = $('wall'), wallN = $('wall-n');
    const api = $('api'), apiLink = $('api-link');
    const live = $('live');
    const modal = $('modal'), modalX = $('modal-x'), copyBtn = $('copy-btn');
    const qrBox = $('qr-box'), qrImg = $('qr-img');
    const modalAmount = $('modal-amount'), modalAddress = $('modal-address');

    // --- State -------------------------------------------------------------
    // One key, unchanged from the previous build so orders already in flight in a
    // customer's browser survive this deploy. New fields are additive; an older entry
    // simply lacks them.
    const STORE = 'opr_orders';
    let orders = [];
    try { orders = JSON.parse(localStorage.getItem(STORE)) || []; } catch { orders = []; }
    const save = () => { try { localStorage.setItem(STORE, JSON.stringify(orders)); } catch { /* quota */ } };

    // --- Helpers -----------------------------------------------------------
    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
    }

    const bytesOf = (s) => new TextEncoder().encode(s || '').length;
    const fmt = (n) => Number(n || 0).toLocaleString();

    // --- Rendering someone else's payload ----------------------------------
    //
    // The wall is the only place this page shows one stranger's content to another, and
    // an image payload is the first thing it shows that is not plain text. The rule that
    // kept the text wall safe — textContent, never innerHTML — does not extend to an
    // image on its own, so these two constants are what replaces it:

    // A CLOSED allowlist of media types. The `data:` URL's type is taken from here and
    // never from the response, so a row claiming some other type cannot get that type into
    // a URL this page builds. Both entries are inert raster formats.
    //
    // NEVER add image/svg+xml. An SVG is markup: it carries <script> and <foreignObject>,
    // and while an <img> tag does not execute either today, that is a browser behaviour to
    // depend on rather than a property of the format. The server refuses SVG at intake for
    // the same reason; both sides have to keep refusing it.
    const RENDERABLE_KINDS = { 'image/webp': 'WebP', 'image/jpeg': 'JPEG' };

    // Exactly what base64 may contain. The server validated this before storing, and it is
    // checked again here because the value is about to be concatenated into a URL —
    // anything outside this set means the string is not what we believe it is.
    const BASE64_ONLY = /^[A-Za-z0-9+\/]+={0,2}$/;

    const isImageKind = (kind) => Object.prototype.hasOwnProperty.call(RENDERABLE_KINDS, kind);

    /**
     * An <img> for a payload we hold the bytes for, or null if anything does not line up.
     *
     * Used for the customer's OWN orders, where the base64 is already in localStorage and
     * there is nothing to fetch. Wall cards use wallImage() below instead.
     *
     * Every caller falls back to text on null. Declining to render is always safe here;
     * guessing never is.
     */
    function payloadImage(message, kind, altText) {
        if (!isImageKind(kind)) return null;
        const b64 = String(message || '');
        if (!b64 || !BASE64_ONLY.test(b64)) return null;
        const img = document.createElement('img');
        img.className = 'payload-img';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = altText || 'Image published on the Bitcoin blockchain';
        img.src = `data:${kind};base64,${b64}`;
        return img;
    }

    /**
     * An <img> for a wall card, fetched from the payload endpoint.
     *
     * The wall listing no longer carries image bytes — a page of 50 was over a megabyte of
     * JSON on every homepage visit. The card gets a transaction id and the browser fetches
     * the image itself, lazily, and caches it as immutable.
     *
     * The URL is built from a txid we validate here, and the media type now comes from the
     * server's Content-Type rather than from anything this page assembles. That is strictly
     * safer than the data: URL it replaces.
     */
    const TXID_ONLY = /^[0-9a-f]{64}$/;
    function wallImage(opReturnTxId, kind, altText) {
        if (!isImageKind(kind)) return null;
        const txid = String(opReturnTxId || '').toLowerCase();
        if (!TXID_ONLY.test(txid)) return null;
        const img = document.createElement('img');
        img.className = 'payload-img';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = altText || 'Image published on the Bitcoin blockchain';
        img.src = `/api/wall/payload/${txid}`;
        // A published payload should always be there, but a card that silently renders a
        // broken-image glyph is worse than one that says what happened.
        img.onerror = () => {
            const note = document.createElement('p');
            note.className = 'wall-empty';
            note.textContent = 'This image could not be loaded.';
            if (img.parentNode) img.parentNode.replaceChild(note, img);
        };
        return img;
    }

    /** What an image payload reads as where a picture will not fit. */
    function describePayload(message, kind) {
        if (!isImageKind(kind)) return message;
        const s = String(message || '');
        const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
        return `[${RENDERABLE_KINDS[kind]} image, ${fmt(Math.round((s.length / 4) * 3 - pad))} bytes]`;
    }

    function ago(iso) {
        const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
        if (!Number.isFinite(mins) || mins < 0) return 'just now';
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const h = Math.floor(mins / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
    }

    // Size of the output paying `address`, mirroring backend/src/tx_sizing.js.
    //
    // CARRIED ACROSS VERBATIM — do not "simplify" the prefix tests. Collapsing bc1q and
    // bc1p into one branch under-quotes both P2WSH and P2TR by 12 vBytes and understates
    // their dust floor by 27 sats, which is precisely the arithmetic that cost four
    // customers refund fees on 2026-08-06. The bc1q length test must stay AFTER the bc1p
    // test, because a P2TR address is also 62 characters. Taproot is live now, so this is
    // a real path rather than the dead code it used to be.
    //
    // Recognised by prefix rather than by decoding — this only drives a preview, and the
    // server is the authority on what is actually charged.
    function recipientOutputVBytes(address) {
        const a = (address || '').trim().toLowerCase();
        if (a.startsWith('bc1p')) return 43;                      // P2TR
        if (a.startsWith('bc1q')) return a.length > 50 ? 43 : 31; // P2WSH : P2WPKH
        if (a.startsWith('3')) return 32;                         // P2SH
        if (a.startsWith('1')) return 34;                         // P2PKH
        return 43;                                                // unknown: quote the largest
    }

    // The dust limit for that output, again mirroring tx_sizing.js: 3 sat/vB against the
    // output plus an undiscounted 148-vByte spend, floored at the service-wide 546.
    function recipientDustLimit(address) {
        return Math.max(546, 3 * (recipientOutputVBytes(address) + 148));
    }

    // The OP_RETURN output size, mirroring tx_sizing.js opReturnOutputVBytes().
    //
    // This replaced a flat `11 + bytes`, which assumed a one-byte push prefix and a
    // one-byte script varint. Both stop being true past 75 bytes, and an image payload is
    // thousands — the old form under-states a 2000-byte payload by 4 vBytes. Small in
    // sats, but this function is also what the budget search inverts, and a preview that
    // disagrees with the server is how a customer gets quoted one number and charged
    // another.
    function opReturnOutputVBytes(dataLength) {
        const pushPrefix = dataLength <= 75 ? 1 : dataLength <= 255 ? 2 : 3;
        const script = 1 + pushPrefix + dataLength;
        const varInt = script < 253 ? 1 : script < 65536 ? 3 : 5;
        return 8 + varInt + script;
    }

    /**
     * What the server will quote for a payload of `bytes` on-chain bytes.
     *
     * The single cost model on this page: the preview, the breakdown and the image budget
     * search all read from it, so there is one place where this arithmetic can be wrong
     * rather than three. Mirrors queue.js.
     */
    function quoteSats(bytes, feeRate, recipient, amount) {
        let vb = 10.5 + 68 + opReturnOutputVBytes(bytes) + 31;
        if (recipient) vb += recipientOutputVBytes(recipient);
        return Math.ceil(vb) * feeRate + SERVICE_FEE + (recipient ? amount : 0);
    }

    /**
     * The largest payload whose quote still fits inside `budget` sats.
     *
     * Binary search rather than algebra: quoteSats has a Math.ceil in the middle of it and
     * inverting that by hand is how the two sides drift apart. Searching the function the
     * preview actually uses means the answer is right by construction.
     */
    function maxBytesForBudget(budget, feeRate, recipient, amount, cap) {
        let lo = 1, hi = cap, best = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (quoteSats(mid, feeRate, recipient, amount) <= budget) { best = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return best;
    }

    // --- Live limits -------------------------------------------------------
    // The image button stays hidden until the server has told us images are allowed and
    // how big they may be. Failing closed matters here: offering an encoder that targets
    // a limit we guessed produces payloads the server then refuses.
    fetch('/api/config/limits')
        .then((r) => r.json())
        .then((d) => {
            if (d.maxPayloadSize) MAX_BYTES = d.maxPayloadSize;
            if (Number.isFinite(d.serviceFeeSats)) SERVICE_FEE = d.serviceFeeSats;
            MAX_IMAGE_BYTES = Number.isFinite(d.maxImagePayloadSize) ? d.maxImagePayloadSize : 0;
            // The server has always sent this and the page has always ignored it, keeping a
            // hardcoded 2 in the markup instead. If MIN_FEE_RATE is ever raised server-side,
            // a slider still offering the old floor produces a guaranteed 400 at intake —
            // which is the exact failure the comment beside the range input warns about.
            if (Number.isFinite(d.minFeeRate) && d.minFeeRate > 0) {
                MIN_FEE = d.minFeeRate;
                feeIn.min = String(MIN_FEE);
            }
            // Probing runs the real encoder once, so it is async. The button stays hidden
            // until it answers — better a button that appears a beat late than one that
            // offers something this browser cannot actually produce.
            if (MAX_IMAGE_BYTES > 0) detectImageMime().then((m) => { if (m) imgBtn.hidden = false; });
            recalc();
        })
        .catch(() => {});

    fetch('/api/health')
        .then((r) => { if (!r.ok) throw new Error(); })
        .catch(() => { live.classList.add('down'); live.lastChild.textContent = ' offline'; });

    // --- Images ------------------------------------------------------------
    //
    // The whole encode happens in this browser. The server never receives the original
    // file, only the few kilobytes that are actually going on the chain.
    //
    // That is a deliberate security choice, not a convenience one. Server-side image
    // decoding means an upload endpoint, temp files, and an image decoder parsing hostile
    // input on the machine that holds the wallet seed — decoders are one of the classic
    // remote-code-execution surfaces. The browser's decoder is already hardened, already
    // sandboxed, and already there.
    //
    // It also strips metadata for free: re-encoding through a canvas drops EXIF, which on
    // a phone photo routinely includes GPS coordinates. This is a permanent public ledger.
    // Nobody publishing a picture of their cat means to publish their home address.

    const IMAGE_MIN_QUALITY = 0.15;
    const IMAGE_MAX_QUALITY = 0.92;
    // Below this, the encoder would rather drop a size than keep smearing detail.
    const IMAGE_GOOD_QUALITY = 0.4;
    // Longest edge, largest first. Stops at 32: smaller is a colour swatch, not a picture.
    //
    // The top rung is the REAL ceiling on what any budget can buy, and it used to be 512 —
    // so above roughly 16,000 on-chain bytes more sats bought literally nothing, silently,
    // no matter how high the service limit went. That is the same broken promise the
    // budget slider cap exists to prevent, one level further down.
    const IMAGE_SIZES = [1024, 800, 640, 512, 400, 320, 256, 200, 160, 128, 96, 64, 48, 32];
    // The largest edge the ladder can offer, used to tell "your budget ran out" apart from
    // "the encoder has nothing bigger to give you".
    const IMAGE_MAX_EDGE = IMAGE_SIZES[0];
    const QUALITY_STEPS = 7;

    // { base64, kind, bytes, width, height } once an image is attached, null otherwise.
    let image = null;
    let encodeToken = 0;   // bumps on every new encode so a slow one cannot land late

    // undefined = not probed yet, false = this browser cannot encode at all,
    // otherwise the media type we will actually produce.
    let imageMime;
    // 'native' = canvas.toBlob, 'wasm' = the bundled libwebp build.
    let encodeVia = null;
    let wasmEncoder = null;

    /** Can canvas.toBlob genuinely produce `type` here? */
    async function canvasSupports(type) {
        const probe = document.createElement('canvas');
        if (!probe.getContext || !probe.toBlob) return false;
        probe.width = probe.height = 8;
        const ctx = probe.getContext('2d');
        if (!ctx) return false;
        // Something non-uniform, so an encoder cannot collapse it to nothing.
        ctx.fillStyle = '#888'; ctx.fillRect(0, 0, 8, 8);
        ctx.fillStyle = '#222'; ctx.fillRect(0, 0, 4, 4);
        let blob = null;
        try { blob = await canvasToBlob(probe, type, 0.8); } catch { return false; }
        // `blob.type`, not merely "did I get a blob". A browser that cannot produce the
        // requested format does not throw — it silently substitutes PNG. Believing that
        // would send PNG bytes labelled image/webp, which intake rejects on the magic-byte
        // check, and the customer would see a failed order with no reason given.
        return !!blob && blob.type === type && blob.size > 0;
    }

    /**
     * WEBP FOR EVERY BROWSER, one way or another.
     *
     * The order matters and the fallback is a last resort, not a peer:
     *
     *   1. Native WebP — free and fastest where it exists.
     *   2. Bundled libwebp (WASM) — same output, costs a ~280 kB one-time download.
     *   3. Native JPEG — only if WebAssembly is somehow unavailable.
     *
     * JPEG used to be step 2, and that was the bug. At these sizes JPEG is roughly TWICE
     * the bytes for the same picture — a fixed header cost that barely shrinks as the image
     * does — so a browser without native WebP silently cost the customer double for the
     * same result. A browser limitation had been allowed to become a product limitation.
     *
     * The codec is NOT loaded here. Detection only decides which route to take; the
     * download happens on the first real encode, so a visitor who never attaches an image
     * never pays for it.
     */
    async function detectImageMime() {
        if (imageMime !== undefined) return imageMime || null;

        if (await canvasSupports('image/webp')) {
            imageMime = 'image/webp'; encodeVia = 'native';
            return imageMime;
        }
        if (typeof WebAssembly === 'object' && typeof WebAssembly.validate === 'function') {
            imageMime = 'image/webp'; encodeVia = 'wasm';
            return imageMime;
        }
        if (await canvasSupports('image/jpeg')) {
            imageMime = 'image/jpeg'; encodeVia = 'native';
            return imageMime;
        }
        imageMime = false;
        return null;
    }

    /**
     * Encodes a canvas to the format detected above.
     *
     * Absolute path for the dynamic import: this file is a classic script, where `import()`
     * resolves against the DOCUMENT's base URL rather than the script's own, so a relative
     * specifier would break the moment the page moved.
     *
     * If the codec cannot be fetched — offline, blocked, a bad deploy — this falls back to
     * JPEG once and stays there, rather than failing every encode. Half a picture beats no
     * picture, and the composer says which format was actually produced.
     */
    async function encodeCanvas(canvas, quality) {
        if (encodeVia === 'wasm') {
            try {
                if (!wasmEncoder) wasmEncoder = await import('/vendor/webp/encoder.js');
                const ctx = canvas.getContext('2d');
                const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
                return await wasmEncoder.encodeWebp(pixels, quality);
            } catch (e) {
                console.warn('[SatWire] WebP codec unavailable, falling back to JPEG:', e && e.message);
                encodeVia = 'native';
                imageMime = (await canvasSupports('image/jpeg')) ? 'image/jpeg' : false;
                if (!imageMime) return null;
            }
        }
        return canvasToBlob(canvas, imageMime, quality);
    }

    const blobToBase64 = (blob) => new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
            const s = String(fr.result);
            const comma = s.indexOf(',');
            comma < 0 ? reject(new Error('bad data url')) : resolve(s.slice(comma + 1));
        };
        fr.onerror = () => reject(fr.error || new Error('read failed'));
        fr.readAsDataURL(blob);
    });

    const canvasToBlob = (canvas, mime, quality) => new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), mime, quality);
    });

    /**
     * Decode the chosen file.
     *
     * Via an <img> rather than createImageBitmap: an <img> applies EXIF orientation, and
     * createImageBitmap only does with an option Safari was late to. A phone photo that
     * publishes sideways forever is not a bug worth shipping to save a few milliseconds.
     */
    function loadImage(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const el = new Image();
            el.onload = () => { URL.revokeObjectURL(url); resolve(el); };
            el.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not a readable image')); };
            el.src = url;
        });
    }

    function drawScaled(source, longestEdge) {
        const w = source.naturalWidth || source.width;
        const h = source.naturalHeight || source.height;
        const scale = Math.min(1, longestEdge / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // JPEG has no alpha. Without a matte, a transparent PNG composites against black
        // and a logo drawn in dark ink disappears entirely.
        if (imageMime === 'image/jpeg') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    /**
     * The LARGEST image that fits in `targetBytes`, at the best quality that size allows.
     *
     * Resolution first, quality second. That ordering is the whole point and it was wrong
     * before: the ladder used to require quality >= IMAGE_GOOD_QUALITY (0.4) before
     * accepting a size, on the reasoning that a smeared big picture reads worse than a
     * clean small one.
     *
     * On 2026-08-09 that cost a customer 41,890 sats. A high-resolution iPhone photo with a
     * ~19,900-byte budget could have been 800x600 at quality 0.22; the gate rejected that,
     * rejected 640x480 at 0.30 and 512x384 at 0.38, and returned 400x300 at 0.92 — spending
     * the entire budget on quality nobody asked for at a quarter of the picture. The
     * customer had asked for the smallest format and the highest resolution, and got the
     * opposite trade.
     *
     * So: walk the ladder from the top and take the FIRST size that fits at all. The binary
     * search below already maximises quality within a size, so this yields the biggest
     * picture the budget can buy and then the sharpest version of it. When that lands on a
     * low quality the composer says so plainly and the customer can look at the preview and
     * spend more — which is a judgement they can make and a threshold in here cannot.
     */
    async function encodeWithin(source, targetBytes) {
        let lastEdge = null;

        for (const size of IMAGE_SIZES) {
            // drawScaled never upscales, so every rung above the source's own longest edge
            // produces an IDENTICAL canvas. Encoding it again just burns up to seven
            // toBlob calls per duplicate rung for a result already known — on a phone with
            // a small source that was most of the wait. Take the first such rung (which is
            // the source at its own size) and skip the rest.
            const edge = Math.min(size, Math.max(source.naturalWidth || source.width, source.naturalHeight || source.height));
            if (edge === lastEdge) continue;
            lastEdge = edge;

            const canvas = drawScaled(source, size);
            let lo = IMAGE_MIN_QUALITY, hi = IMAGE_MAX_QUALITY, fit = null;

            for (let i = 0; i < QUALITY_STEPS; i++) {
                const q = (lo + hi) / 2;
                const blob = await encodeCanvas(canvas, q);
                if (!blob) break;
                if (blob.size <= targetBytes) { fit = { blob, q, canvas }; lo = q; }
                else hi = q;
            }

            // The first size that fits at all wins, because the ladder runs largest-first.
            // No quality gate: the binary search above has already found the best quality
            // this size can afford, and a smaller-but-sharper alternative is a trade the
            // customer makes by looking at the preview, not one this function makes for
            // them. See the note above encodeWithin for what that gate cost.
            if (fit) return fit;
        }
        return null;
    }

    /**
     * Re-encode the pending file to the current budget and update the composer.
     *
     * `encodeToken` guards against a slow encode landing after a newer one: dragging the
     * budget slider fires this on every step, and without the token an early, larger
     * result could overwrite a later, smaller one — leaving the preview and the price
     * describing different images.
     */
    /**
     * Stop the budget slider where extra sats stop buying picture.
     *
     * Rounded up to a whole step so the top of the track is reachable, and re-applied on
     * every encode because the saturation point moves with the fee rate and the recipient
     * amount — the same 2000 bytes costs more at 10 sat/vB than at 2.
     */
    function capBudgetSlider(saturationBudget) {
        const step = parseInt(imgBudget.step, 10) || 500;
        const min = parseInt(imgBudget.min, 10) || 0;
        const capped = Math.max(min + step, Math.ceil(saturationBudget / step) * step);
        if (String(capped) === imgBudget.max) return;
        imgBudget.max = String(capped);
        if ((parseInt(imgBudget.value, 10) || 0) > capped) {
            imgBudget.value = String(capped);
            imgBudgetN.textContent = fmt(capped);
        }
    }

    let pendingSource = null;
    // The byte cost of the biggest picture this source can produce, learned once the
    // ladder is seen to top out. Null while the budget is still the thing limiting us.
    // Reset with the image, because it is a property of the source, not of the session.
    let encoderCeiling = null;

    async function reencode() {
        if (!pendingSource) return;
        const token = ++encodeToken;

        const feeRate = parseInt(feeIn.value, 10) || 2;
        const recipient = addrIn.value.trim();
        const amount = recipient ? (parseInt(amtIn.value, 10) || 0) : 0;
        const budget = parseInt(imgBudget.value, 10) || 0;

        // What the budget buys, never more than the server will accept.
        const target = Math.min(
            MAX_IMAGE_BYTES,
            maxBytesForBudget(budget, feeRate, recipient, amount, MAX_IMAGE_BYTES)
        );

        // Past the point where the budget saturates MAX_IMAGE_BYTES, more sats buy
        // literally nothing — the target stops moving and so does the picture. A slider
        // that keeps travelling there is the UI making a promise the service cannot keep,
        // which is how somebody ends up paying 25,000 sats for the same image 6,250 would
        // have bought. Say so, and stop the slider there.
        // TWO ceilings, and the slider must stop at whichever bites first:
        //   - the service limit (MAX_IMAGE_BYTES), and
        //   - the encoder itself, which cannot draw bigger than IMAGE_MAX_EDGE and never
        //     upscales past the source.
        // Capping only on the first is what let the slider run to 42,000 sats for a picture
        // that stopped changing at 16,000. `encoderCeiling` is learned from the last encode
        // — the byte cost of the largest thing this source can produce — and is null until
        // we have seen the ladder actually top out.
        const budgetCeiling = encoderCeiling != null
            ? Math.min(MAX_IMAGE_BYTES, encoderCeiling)
            : MAX_IMAGE_BYTES;
        capBudgetSlider(quoteSats(budgetCeiling, feeRate, recipient, amount));
        const pinned = target >= MAX_IMAGE_BYTES;

        if (target <= 0) {
            imgNote.textContent = 'That budget does not cover the service fee yet — raise it.';
            imgNote.className = 'note warn'; syncImageView();
            image = null;
            recalc();
            return;
        }

        imgNote.textContent = 'Compressing…';
        imgNote.className = 'note'; syncImageView();

        let fit;
        try {
            fit = await encodeWithin(pendingSource, target);
        } catch {
            fit = null;
        }
        if (token !== encodeToken) return;

        if (!fit) {
            imgNote.textContent = 'Could not get this image under the budget. Try a larger one.';
            imgNote.className = 'note warn'; syncImageView();
            image = null;
            recalc();
            return;
        }

        // Last line of defence: the bytes must actually be the format we are about to
        // declare. If the detection above was wrong in any way, the browser will have
        // silently handed back PNG, and PNG labelled image/webp is refused at intake on
        // the magic-byte check — the customer would see a failed order with no reason
        // given. Catching it here costs nothing and turns it into a sentence.
        if (fit.blob.type !== imageMime) {
            imgNote.textContent = `This browser produced ${fit.blob.type || 'an unknown format'} instead of ${RENDERABLE_KINDS[imageMime] || imageMime}. Cannot publish that.`;
            imgNote.className = 'note warn'; syncImageView();
            image = null;
            recalc();
            return;
        }

        let base64;
        try {
            base64 = await blobToBase64(fit.blob);
        } catch {
            if (token === encodeToken) {
                imgNote.textContent = 'Could not read the compressed image.';
                imgNote.className = 'note warn'; syncImageView();
            }
            return;
        }
        if (token !== encodeToken) return;

        image = {
            base64,
            kind: imageMime,
            bytes: fit.blob.size,
            width: fit.canvas.width,
            height: fit.canvas.height,
        };

        // Built from our own freshly-encoded blob, so this is the one data: URL on the
        // page whose contents are not in question.
        imgPreview.src = `data:${imageMime};base64,${base64}`;
        imgDims.textContent = `${image.width} × ${image.height}`;

        // Naming the source size is not decoration. drawScaled never upscales, so an image
        // whose longest edge is already small stays that size no matter what the budget
        // is — and without this the composer looks broken rather than honest.
        const sw = pendingSource.naturalWidth || pendingSource.width;
        const sh = pendingSource.naturalHeight || pendingSource.height;
        const atSourceSize = Math.max(image.width, image.height) >= Math.max(sw, sh);

        // Naming the FORMAT matters more than it looks. JPEG is roughly twice the size of
        // WebP at these dimensions — a fixed header cost that barely moves while the image
        // shrinks — so a browser that cannot encode WebP silently lands about two rungs
        // lower on the size ladder for the same money. Without this, that reads as "the
        // encoder is bad" rather than "this browser cannot do WebP".
        const label = RENDERABLE_KINDS[image.kind] || image.kind;
        imgSize.textContent = `${fmt(image.bytes)} bytes on-chain · ${label} · from ${sw} × ${sh}`;

        // Learn the encoder's own ceiling: we asked for `target` bytes and the ladder came
        // back at its largest possible size without using them all, so nothing bigger
        // exists for this source and more budget is wasted. Recording the actual byte cost
        // lets the slider stop exactly there on the next pass.
        const atLadderTop = Math.max(image.width, image.height) >= Math.min(IMAGE_MAX_EDGE, Math.max(sw, sh));
        encoderCeiling = (atLadderTop && fit.blob.size < target) ? fit.blob.size : null;

        if (atSourceSize) {
            imgNote.textContent = 'This is the original size — a bigger budget cannot add detail that is not there.';
        } else if (atLadderTop) {
            imgNote.textContent = `${IMAGE_MAX_EDGE}px is the largest this publishes — more budget would not make it bigger.`;
        } else if (pinned) {
            imgNote.textContent = `Capped at the ${fmt(MAX_IMAGE_BYTES)}-byte service limit, not by your budget.`;
        } else if (image.kind === 'image/jpeg') {
            // Should be unreachable now that libwebp ships with the page — it means the
            // codec could not be fetched at all. Kept, and kept honest about the cost.
            imgNote.textContent = 'The WebP encoder could not be loaded, so this is JPEG — roughly half the picture for the same sats. Reloading usually fixes it.';
        } else if (fit.q >= IMAGE_GOOD_QUALITY) {
            imgNote.textContent = 'Everything above goes in the transaction, permanently.';
        } else {
            imgNote.textContent = 'Squeezed hard to fit. A bigger budget would look better.';
        }
        imgNote.className = 'note'; syncImageView();

        recalc();
    }

    async function chooseImage(file) {
        if (!file) return;
        if (!(await detectImageMime())) return;

        imgBox.hidden = false;
        // The WASM codec is fetched on first use, so say so rather than looking stuck.
        imgNote.textContent = (encodeVia === 'wasm' && !wasmEncoder)
            ? 'Loading the WebP encoder…'
            : 'Reading…';
        imgNote.className = 'note'; syncImageView();

        try {
            pendingSource = await loadImage(file);
        } catch {
            pendingSource = null;
            image = null;
            imgNote.textContent = 'That file could not be read as an image.';
            imgNote.className = 'note warn'; syncImageView();
            recalc();
            return;
        }
        await reencode();
    }

    /**
     * Mirrors the composer's readout into the open preview.
     *
     * The dialog never computes anything of its own — it shows the same strings the small
     * box shows, so the two cannot describe different images. Called after every encode and
     * on open.
     */
    function syncImageView() {
        if (imgView.hidden) return;
        imgViewImg.src = imgPreview.getAttribute('src') || '';
        imgViewDims.textContent = imgDims.textContent;
        imgViewSize.textContent = imgSize.textContent;
        imgViewNote.textContent = imgNote.textContent;
        imgViewNote.className = imgNote.className;
    }

    /**
     * Opens the larger preview and MOVES the budget slider into it.
     *
     * Moved, not copied. One control means the value the customer is dragging is by
     * definition the value driving the encode; two synced inputs would be two sources of
     * truth for one number, and the one being looked at could drift from the one in effect.
     * Its listeners travel with the element, so nothing needs rebinding.
     */
    function openImageView() {
        if (!image && !pendingSource) return;
        imgViewSlot.appendChild(imgBudgetRow);
        imgView.hidden = false;
        syncImageView();
        imgViewX.focus();
    }

    function closeImageView() {
        if (imgView.hidden) return;
        // Put the slider back before hiding, or it would be inside a hidden dialog and
        // unreachable until the next open.
        imgBudgetHome.appendChild(imgBudgetRow);
        imgView.hidden = true;
        imgOpen.focus();
    }

    function clearImage() {
        closeImageView();
        encodeToken++;           // orphan any encode still in flight
        pendingSource = null;
        image = null;
        encoderCeiling = null;   // a property of the source, so it goes with it
        imgFile.value = '';      // so re-picking the same file still fires `change`
        imgPreview.removeAttribute('src');
        imgBox.hidden = true;
        recalc();
        msg.focus();
    }

    // --- Cost --------------------------------------------------------------
    let shownTotal = 0, raf = null;
    function animateTotal(target) {
        if (raf) cancelAnimationFrame(raf);
        const from = shownTotal;
        let start = null;
        const step = (ts) => {
            if (start === null) start = ts;
            let k = Math.min(1, (ts - start) / 260);
            k = 1 - Math.pow(1 - k, 3);
            shownTotal = Math.round(from + (target - from) * k);
            totalN.textContent = fmt(shownTotal);
            if (k < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
    }

    function recalc() {
        // An image replaces the text — one OP_RETURN carries one payload. The textarea is
        // disabled rather than hidden so it is obvious what happened and what removing the
        // image will give back.
        const imageMode = !!image || !!pendingSource;
        msg.disabled = imageMode;
        msg.placeholder = imageMode
            ? 'The image below is your message.'
            : 'Say it once, and let it outlive you…';

        let bytes;
        let limit;
        if (imageMode) {
            bytes = image ? image.bytes : 0;
            limit = MAX_IMAGE_BYTES || 1;
        } else {
            bytes = bytesOf(msg.value);
            limit = MAX_BYTES;
            if (bytes > limit) {
                let cut = msg.value;
                while (bytesOf(cut) > limit) cut = cut.slice(0, -1);
                msg.value = cut;
                bytes = limit;
            }
        }

        ringN.textContent = bytes >= 1000 ? `${Math.floor(bytes / 1000)}k` : bytes;
        ring.querySelector('.fill').style.strokeDashoffset = RING_CIRC - RING_CIRC * Math.min(1, bytes / limit);
        ring.className = bytes >= limit ? 'ring full' : 'ring';

        // Fall back rather than let a NaN through: fmt() would render it as "0", and a
        // quote reading "0 sats" is worse than a wrong one, because it looks deliberate.
        const fee = parseInt(feeIn.value, 10) || MIN_FEE;
        feeN.textContent = fee;

        const recipient = addrIn.value.trim();
        let amount = parseInt(amtIn.value, 10) || 0;
        if (!recipient) amount = 0;

        const total = quoteSats(bytes, fee, recipient, amount);
        bdNet.textContent = fmt(total - SERVICE_FEE - amount);
        bdSvc.textContent = fmt(SERVICE_FEE);
        bdRec.textContent = fmt(amount);
        animateTotal(total);

        // What the fee slider actually costs, named in sats.
        //
        // The rate multiplies the WHOLE transaction, so one step is worth ~250 sats on a
        // short message and ~12,000 on a 12 kB picture. On 2026-08-11 a customer was quoted
        // 124,970 sats for a 12,038-byte image; 97,576 of that was the slider sitting at 10
        // rather than at the floor of 2. The total was on screen the entire time — what was
        // missing was which control had produced it.
        //
        // Derived from quoteSats, not from totalN: that element is written from inside a
        // requestAnimationFrame and is mid-animation whenever this runs.
        const extra = total - quoteSats(bytes, MIN_FEE, recipient, amount);
        feeExtra.hidden = extra <= 0;
        feeExtra.textContent = extra > 0 ? `+${fmt(extra)}` : '';
        feeCostNote.textContent = extra > 0
            ? `${fee} sat/vB costs ${fmt(extra)} sats more than ${MIN_FEE}. It only buys a faster confirmation — the message published is the same.`
            : `${MIN_FEE} sat/vB is the cheapest rate the network accepts.`;

        // Say the minimum out loud, before any money moves. The server refuses a sub-dust
        // amount, but a customer who only finds that out after paying has learned it the
        // expensive way — which is exactly what happened on 2026-08-06.
        if (recipient) {
            const min = recipientDustLimit(recipient);
            amtIn.min = String(min);
            const tooSmall = amount > 0 && amount < min;
            // The split, said out loud the moment an amount exists.
            //
            // The breakdown already carried these two numbers, but it is collapsed by
            // default. A customer paying 124,970 sats to forward 1,000 of them has misread
            // what this page does, and the one number he could see did not tell him — it
            // takes both numbers, side by side, to make the proportion obvious.
            amtNote.textContent = tooSmall
                ? `Below ${min} sats the network drops this output as dust.`
                : amount > 0
                    ? `${fmt(amount)} sats reach that address. ${fmt(total - amount)} sats publish your message.`
                    : `0, or at least ${min} for this address.`;
            amtNote.className = tooSmall ? 'note warn' : 'note';
            amtIn.style.borderColor = tooSmall ? 'var(--red)' : '';
        } else {
            amtIn.min = '0';
            amtNote.textContent = 'Optional. SatWire publishes your message — this only adds a payment on top.';
            amtNote.className = 'note';
            amtIn.style.borderColor = '';
        }
    }

    // --- Order status ------------------------------------------------------
    // Every status the backend can produce. Nine are stored; `archived` is synthesised by
    // routes/api.js for a request it has retired.
    const FAILURE_STATUSES = ['op_return_failed', 'refund_failed', 'refund_processing', 'refunded'];
    const isFailure = (s) => FAILURE_STATUSES.includes(s);

    // Statuses where nothing further can change, so polling stops. `archived` belongs
    // here: the row is final, and without it the browser polls a dead request forever.
    const TERMINAL_STATUSES = ['op_return_broadcasted', 'refunded', 'refund_failed', 'archived'];

    // Five steps: Created, Paid, Confirmed, Published, In a block.
    //
    // Always returns five entries. An earlier version returned a shorter array for some
    // statuses and the renderer skipped the empty ones, which made an archived order draw
    // as a single dot pinned to the right with no track at all — the CSS sizes the last
    // step to its content and strips its connector.
    //
    // '' | 'done' | 'now' | 'bad'
    const RAIL_LABELS = ['Created', 'Paid', 'Confirmed', 'Published', 'In a block'];

    function railFor(order) {
        const s = order.status;
        const mined = !!order.opReturnConfirmedAt;

        switch (s) {
            case 'pending_payment':       return ['done', 'now', '', '', ''];
            case 'payment_detected':      return ['done', 'done', 'now', '', ''];
            // payment_confirmed and processing_op_return are the same thing to a customer:
            // the money is in and we are building. processing_op_return is a mutex, not a
            // stage, and reconcile flips it back after 30 minutes.
            case 'payment_confirmed':
            case 'processing_op_return':  return ['done', 'done', 'done', 'now', ''];
            case 'op_return_broadcasted': return ['done', 'done', 'done', 'done', mined ? 'done' : 'now'];
            case 'refunded':              return ['done', 'done', 'done', 'bad', ''];
            case 'refund_processing':
            case 'refund_failed':
            case 'op_return_failed':      return ['done', 'done', 'done', 'bad', ''];
            // Withdrawn. Usually it stops there — but an operator can still publish or
            // refund an archived order, so follow the evidence rather than the status.
            case 'archived':
                if (order.txId) return ['done', 'done', 'done', 'done', mined ? 'done' : 'now'];
                if (order.refundTxId) return ['done', 'done', 'done', 'bad', ''];
                return ['bad', '', '', '', ''];
            default:                      return ['done', 'now', '', '', ''];
        }
    }

    function labelFor(order) {
        switch (order.status) {
            case 'pending_payment':       return 'Awaiting payment';
            case 'payment_detected':      return 'Payment seen, waiting for a confirmation';
            case 'payment_confirmed':     return 'Paid — publishing';
            case 'processing_op_return':  return 'Publishing';
            case 'op_return_broadcasted':
                return order.opReturnConfirmedAt
                    ? 'In a block — permanent'
                    : 'Published. Waiting for a miner to include it, which can take a while at a low fee rate.';
            case 'op_return_failed':      return 'Could not publish';
            case 'refund_processing':     return 'Refunding';
            case 'refunded':              return 'Refunded';
            case 'refund_failed':         return 'Refund needs manual review';
            case 'archived':              return order.archivedReason === 'cancelled_by_customer' ? 'Cancelled' : 'Expired';
            default:                      return String(order.status || '').replace(/_/g, ' ');
        }
    }

    // --- Orders ------------------------------------------------------------
    const drafts = {};   // in-progress feedback text, kept out of the DOM across re-renders

    function addOrder(data) {
        if (orders.some((o) => o.requestId === data.requestId)) return;
        orders.unshift({ ...data, status: 'pending_payment', createdAt: new Date().toISOString() });
        save();
        renderOrders();
    }

    function removeOrder(id) {
        orders = orders.filter((o) => o.requestId !== id);
        save();
        renderOrders();
    }

    function applyStatus(id, data) {
        const order = orders.find((o) => o.requestId === id);
        if (!order) return;
        let changed = false;
        const set = (k, v) => {
            if (v !== undefined && v !== null && order[k] !== v) { order[k] = v; changed = true; }
        };
        set('status', data.status);
        set('payloadKind', data.payloadKind);
        set('txId', data.opReturnTxId);
        set('supportEmail', data.supportEmail);
        set('refundTxId', data.refundTxId);
        set('failureReason', data.failureReason);
        set('archivedReason', data.archivedReason);
        set('opReturnConfirmedAt', data.opReturnConfirmedAt);
        set('opReturnBlockHeight', data.opReturnBlockHeight);
        // The server explains a retired request in `error`. Keep it — the customer
        // otherwise sees a bare status and no reason.
        if (data.status === 'archived') set('archivedNote', data.error);
        if (data.userFeedback && !order.feedbackSent) { order.feedbackSent = true; changed = true; }
        if (changed) { save(); renderOrders(); }
    }

    function renderOrders() {
        mine.hidden = orders.length === 0;
        if (!orders.length) { ordersEl.innerHTML = ''; return; }

        // Remember where the cursor was — a poll re-renders every 5 seconds.
        const active = document.activeElement;
        const focusedId = active && active.classList && active.classList.contains('feedback-input')
            ? active.dataset.id : null;
        const caret = focusedId ? active.selectionStart : null;

        ordersEl.innerHTML = '';

        orders.forEach((order, i) => {
            const failed = isFailure(order.status);
            const done = order.status === 'op_return_broadcasted';
            const el = document.createElement('article');
            el.className = `order${failed ? ' is-failed' : ''}${done ? ' is-done' : ''}`;
            el.style.animationDelay = `${Math.min(i, 6) * 0.03}s`;

            const rail = railFor(order);
            const railLabels = (order.status === 'archived' && !order.txId && !order.refundTxId)
                ? ['Withdrawn', '', '', '', '']
                : RAIL_LABELS;

            // Feedback box: only once the request has actually failed, and only until sent.
            let feedbackHtml = '';
            if (failed) {
                feedbackHtml = order.feedbackSent
                    ? '<div class="feedback-sent">Your message was sent to the operator. Thank you.</div>'
                    : `<div class="feedback">
                         <label for="fb-${escapeHtml(order.requestId)}">Something went wrong. Leave a message for the operator:</label>
                         <textarea id="fb-${escapeHtml(order.requestId)}" class="feedback-input" data-id="${escapeHtml(order.requestId)}"
                                   maxlength="1000" placeholder="What happened, and how can we reach you?">${escapeHtml(drafts[order.requestId] || '')}</textarea>
                         <div class="feedback-row">
                           <button class="btn-s act-feedback" type="button" data-id="${escapeHtml(order.requestId)}">Send</button>
                           <span class="feedback-counter">0 / 1000</span>
                         </div>
                       </div>`;
            }

            el.innerHTML = `
                <div class="order-top">
                    <span>${escapeHtml(order.requestId.substring(0, 8))}</span>
                    <span>·</span>
                    <span>${escapeHtml(ago(order.createdAt))}</span>
                </div>
                <div class="order-msg">${escapeHtml(describePayload(order.message, order.payloadKind))}${order.isPublic ? '<span class="tag">on the wall</span>' : ''}</div>
                ${/* ALWAYS five <li>. Skipping the unlabelled ones collapses the flex row
                      and the rail renders as one stray dot with no track — the last step
                      is sized to its content and has its connector removed by design. */ ''}
                <ol class="rail">
                    ${rail.map((c, n) => `<li class="${c}"><span>${escapeHtml(railLabels[n] || '')}</span></li>`).join('')}
                </ol>
                <div class="order-note" style="${order.status === 'pending_payment' || (done && order.opReturnConfirmedAt) ? 'display:none' : ''}">${escapeHtml(labelFor(order))}</div>
                ${order.archivedNote ? `<div class="order-note bad">${escapeHtml(order.archivedNote)}</div>` : ''}
                ${order.refundTxId ? `<div class="order-note good">Your payment was refunded — <a href="https://mempool.space/tx/${encodeURIComponent(order.refundTxId)}" target="_blank" rel="noopener">view transaction ↗</a></div>` : ''}
                ${failed && order.supportEmail ? `<div class="order-note">Need help? <a href="mailto:${escapeHtml(order.supportEmail)}?subject=SatWire%20request%20${encodeURIComponent(order.requestId)}">${escapeHtml(order.supportEmail)}</a></div>` : ''}
                ${feedbackHtml}
                <div class="order-foot">
                    ${/* An ALLOWLIST, and it must stay one. The server relies on it: reporting
                          'archived' removes the PAY button from an already-open tab with no
                          frontend deploy, and that only works because the button renders for
                          known-live statuses rather than "anything not terminal". Inverting it
                          gives a retired order a working PAY button pointing at a dead address,
                          because the amount and address come from localStorage. */ ''}
                    ${order.status === 'pending_payment' ? `<button class="btn-s primary act-pay" type="button" data-id="${escapeHtml(order.requestId)}">Pay ${fmt(order.requiredAmountSatoshis)} sats</button>` : ''}
                    ${order.txId ? `<a class="btn-s" href="https://mempool.space/tx/${encodeURIComponent(order.txId)}" target="_blank" rel="noopener">View on-chain ↗</a>` : ''}
                    <button class="btn-s act-drop" type="button" data-id="${escapeHtml(order.requestId)}">${(done || failed || order.status === 'archived') ? 'Remove' : 'Cancel'}</button>
                </div>`;

            ordersEl.appendChild(el);

            // Appended after the innerHTML above rather than interpolated into it, for the
            // same reason as the wall: the payload never reaches the HTML parser. The
            // text description written above stays as the fallback when this returns null.
            const orderImg = payloadImage(order.message, order.payloadKind, 'Your image');
            if (orderImg) {
                const slot = el.querySelector('.order-msg');
                slot.textContent = '';
                slot.appendChild(orderImg);
                if (order.isPublic) {
                    const tag = document.createElement('span');
                    tag.className = 'tag';
                    tag.textContent = 'on the wall';
                    slot.appendChild(tag);
                }
            }

            const fbInput = el.querySelector('.feedback-input');
            const fbCount = el.querySelector('.feedback-counter');
            if (fbInput && fbCount) {
                const sync = () => { fbCount.textContent = `${bytesOf(fbInput.value)} / 1000`; };
                sync();
                fbInput.addEventListener('input', () => { drafts[order.requestId] = fbInput.value; sync(); });
            }
        });

        if (focusedId) {
            const restored = ordersEl.querySelector(`.feedback-input[data-id="${CSS.escape(focusedId)}"]`);
            if (restored) {
                restored.focus();
                if (caret !== null) { try { restored.setSelectionRange(caret, caret); } catch { /* ignore */ } }
            }
        }
    }

    // One delegated listener rather than per-card bindings, so a re-render cannot leak them.
    ordersEl.addEventListener('click', (e) => {
        const pay = e.target.closest('.act-pay');
        const drop = e.target.closest('.act-drop');
        const fb = e.target.closest('.act-feedback');
        if (pay) openPayment(orders.find((o) => o.requestId === pay.dataset.id));
        if (drop) dropOrder(drop.dataset.id);
        if (fb) sendFeedback(fb.dataset.id, fb);
    });

    // --- API ---------------------------------------------------------------
    async function broadcast() {
        // An image still mid-encode has no payload yet, and publishing the empty textarea
        // underneath it would put a blank message on the chain for real money.
        if (pendingSource && !image) { return; }
        if (!image && !bytesOf(msg.value)) { msg.focus(); return; }

        const payloadKind = image ? image.kind : 'text';
        const payloadBody = image ? image.base64 : msg.value;

        go.disabled = true;
        const label = go.innerHTML;
        go.textContent = 'Working…';

        try {
            const res = await fetch('/api/message-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: payloadBody,
                    payloadKind,
                    targetAddress: addrIn.value.trim() || undefined,
                    feeRate: parseInt(feeIn.value, 10),
                    amountToSend: parseInt(amtIn.value, 10) || 0,
                    isPublic: !!publicToggle.checked,
                }),
            });
            const data = await res.json();

            if (res.ok) {
                addOrder({
                    requestId: data.requestId,
                    address: data.address,
                    requiredAmountSatoshis: data.requiredAmountSatoshis,
                    // What the SERVER recorded, not what we asked for.
                    isPublic: !!data.isPublic,
                    message: payloadBody,
                    payloadKind,
                });
                msg.value = '';
                if (image || pendingSource) clearImage();
                recalc();
                const fresh = orders[0];
                if (fresh) openPayment(fresh);
            } else {
                // Covers the 429 from intake throttling, whose body explains the limit.
                alert(data.error || 'Something went wrong. Please try again.');
            }
        } catch {
            alert('Network error. Check your connection and try again.');
        } finally {
            go.disabled = false;
            go.innerHTML = label;
        }
    }

    async function dropOrder(id) {
        const order = orders.find((o) => o.requestId === id);
        if (!order) return;
        const settled = order.status !== 'pending_payment' && order.status !== 'payment_detected';
        if (settled) { removeOrder(id); return; }
        if (!confirm('Cancel this request?')) return;
        try {
            const res = await fetch(`/api/request/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (res.ok || res.status === 404) { removeOrder(id); return; }
            const data = await res.json();
            alert(data.error || 'Could not cancel this request.');
        } catch {
            alert('Network error.');
        }
    }

    async function sendFeedback(id, button) {
        const box = ordersEl.querySelector(`.feedback-input[data-id="${CSS.escape(id)}"]`);
        const text = (box && box.value.trim()) || '';
        if (!text) { if (box) box.focus(); return; }

        button.disabled = true;
        button.textContent = 'Sending…';
        try {
            const res = await fetch(`/api/request/${encodeURIComponent(id)}/feedback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
            });
            const data = await res.json();
            if (res.ok) {
                const order = orders.find((o) => o.requestId === id);
                if (order) { order.feedbackSent = true; delete drafts[id]; save(); renderOrders(); }
            } else {
                alert(data.error || 'Could not send that.');
                button.disabled = false;
                button.textContent = 'Send';
            }
        } catch {
            alert('Network error. Please try again.');
            button.disabled = false;
            button.textContent = 'Send';
        }
    }

    // A broadcast order is no longer finished the moment it broadcasts — it still has to
    // reach a block, and the server learns that separately. So it stays pollable until
    // it does, but on a much slower cadence: a confirmation takes ~10 minutes at best,
    // and at the 2 sat/vB floor it can take days. Polling that every 5 seconds would be
    // thousands of pointless requests per order.
    const CONFIRM_POLL_MS = 60 * 1000;
    const lastConfirmPoll = {};

    function needsPolling(order) {
        if (!TERMINAL_STATUSES.includes(order.status)) return true;
        if (order.status !== 'op_return_broadcasted' || order.opReturnConfirmedAt) return false;
        // Stamped BEFORE the request, not after: a slow or failed fetch would otherwise
        // leave the mark unset and the order would fire again on every single tick.
        const now = Date.now();
        if (now - (lastConfirmPoll[order.requestId] || 0) < CONFIRM_POLL_MS) return false;
        lastConfirmPoll[order.requestId] = now;
        return true;
    }

    // poll() awaits one request per order in sequence, while setInterval fires regardless.
    // Without this guard a slow connection stacks overlapping passes on top of each other,
    // each one re-requesting everything. Pre-existing; it only gets worse as the polled
    // set grows.
    let polling = false;

    async function poll() {
        if (polling || !orders.length) return;
        if (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible') return;
        polling = true;
        try {
            for (const order of [...orders]) {
                if (!needsPolling(order)) continue;
                try {
                    const res = await fetch(`/api/request-status/${encodeURIComponent(order.requestId)}`);
                    if (!res.ok) continue;
                    applyStatus(order.requestId, await res.json());
                } catch { /* silent — the next tick tries again */ }
            }
        } finally {
            polling = false;
        }
    }

    // --- The wall ----------------------------------------------------------
    // The last listing's ETag. renderWall() clears #wall and rebuilds every card, and this
    // runs once a minute in every open tab — so an unchanged wall used to re-create the
    // whole DOM, restart the card animations and re-lay out the images for nothing.
    //
    // The server has always sent a stable ETag for this response (cachedAt moved to a header
    // precisely so it would be stable). A 304 is therefore the normal answer, and the right
    // reaction to one is to leave the DOM alone.
    let wallEtag = null;

    async function loadWall() {
        try {
            const res = await fetch('/api/wall', {
                headers: wallEtag ? { 'If-None-Match': wallEtag } : {},
            });
            if (res.status === 304) return;          // nothing published since last time
            if (!res.ok) throw new Error('wall');
            const tag = res.headers.get('ETag');
            const data = await res.json();
            // Stored only after the body parses, so a truncated response cannot make us
            // skip the next poll as well.
            wallEtag = tag;
            renderWall(data.messages || []);
        } catch {
            wallEtag = null;                         // re-fetch in full next time
            wallEl.innerHTML = '';
            const p = document.createElement('p');
            p.className = 'wall-empty';
            p.textContent = 'Could not load the wall just now.';
            wallEl.appendChild(p);
        }
    }

    function renderWall(messages) {
        wallEl.innerHTML = '';
        wallN.textContent = messages.length ? `${fmt(messages.length)} published` : '';

        if (!messages.length) {
            const p = document.createElement('p');
            p.className = 'wall-empty';
            p.textContent = 'Nothing here yet. Yours could be first.';
            wallEl.appendChild(p);
            return;
        }

        messages.forEach((m, i) => {
            const card = document.createElement('article');
            card.className = 'note-card';
            card.style.animationDelay = `${Math.min(i, 12) * 0.04}s`;

            // textContent, not innerHTML. This is content written by strangers, rendered
            // on the same origin that serves /admin. The escaper would very probably be
            // enough; not depending on it is cheaper than being sure.
            //
            // An image takes the same approach one step further: built with DOM calls from
            // a validated base64 string and an allowlisted media type, so the payload never
            // passes through the HTML parser either. payloadImage returns null on anything
            // unexpected and the card falls back to describing it in text.
            const p = document.createElement('p');
            const img = wallImage(m.opReturnTxId, m.payloadKind, 'A picture published on the Bitcoin blockchain');
            if (img) {
                card.classList.add('is-image');
                p.appendChild(img);
            } else {
                // Text rows carry their message inline; image rows never do.
                p.textContent = m.message || '';
            }

            const foot = document.createElement('footer');
            const when = document.createElement('span');
            when.textContent = m.publishedAt ? ago(m.publishedAt) : '';
            foot.appendChild(when);

            if (m.opReturnTxId) {
                const link = document.createElement('a');
                link.href = `https://mempool.space/tx/${encodeURIComponent(m.opReturnTxId)}`;
                link.target = '_blank';
                link.rel = 'noopener';
                link.textContent = 'tx ↗';
                foot.appendChild(link);
            }

            card.appendChild(p);
            card.appendChild(foot);
            wallEl.appendChild(card);
        });
    }

    // --- Payment modal -----------------------------------------------------
    function openPayment(order) {
        if (!order) return;
        modalAmount.textContent = fmt(order.requiredAmountSatoshis);
        modalAddress.textContent = order.address;

        qrBox.className = 'qr';
        qrImg.style.display = '';
        qrImg.src = `/api/payment-qr.svg?requestId=${encodeURIComponent(order.requestId)}`;
        qrImg.onerror = () => {
            // 410 once the order is archived or its webhooks are retired, 409 once it is
            // no longer awaiting payment. The address below stays readable either way.
            qrImg.style.display = 'none';
            qrBox.className = 'qr failed';
            qrBox.textContent = 'This request is no longer open for payment.';
        };

        modal.hidden = false;
    }
    const closePayment = () => { modal.hidden = true; };

    // --- Disclosures -------------------------------------------------------
    optBtn.addEventListener('click', () => {
        optBtn.setAttribute('aria-expanded', drawer.classList.toggle('open') ? 'true' : 'false');
    });

    const toggleBreakdown = () => {
        totalBtn.setAttribute('aria-expanded', breakdown.classList.toggle('open') ? 'true' : 'false');
    };
    totalBtn.addEventListener('click', toggleBreakdown);
    totalBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBreakdown(); }
    });

    function openApiIfHashed() {
        if (location.hash === '#api') {
            api.open = true;
            api.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
    apiLink.addEventListener('click', () => setTimeout(openApiIfHashed, 0));
    window.addEventListener('hashchange', openApiIfHashed);

    // --- Wiring ------------------------------------------------------------
    [msg, addrIn, amtIn, feeIn].forEach((el) => {
        el.addEventListener('input', recalc);
        el.addEventListener('change', recalc);
    });
    go.addEventListener('click', broadcast);

    // --- Image wiring ------------------------------------------------------
    imgBtn.addEventListener('click', () => imgFile.click());
    imgFile.addEventListener('change', () => chooseImage(imgFile.files && imgFile.files[0]));
    imgClear.addEventListener('click', clearImage);
    imgOpen.addEventListener('click', openImageView);
    imgViewX.addEventListener('click', closeImageView);
    imgView.addEventListener('click', (e) => { if (e.target === imgView) closeImageView(); });

    // The slider is continuous and each step is a full re-encode, so coalesce: without
    // this, dragging from one end to the other queues dozens of encodes that the token
    // guard then throws away. The label updates immediately either way, so the control
    // still feels direct.
    let budgetTimer = null;
    imgBudget.addEventListener('input', () => {
        imgBudgetN.textContent = fmt(parseInt(imgBudget.value, 10) || 0);
        clearTimeout(budgetTimer);
        budgetTimer = setTimeout(reencode, 140);
    });

    // The byte budget is derived from the fee rate, the recipient and the amount, so a
    // change to any of those changes how much picture the same sat budget buys.
    [addrIn, amtIn, feeIn].forEach((el) => {
        el.addEventListener('change', () => {
            if (!pendingSource) return;
            clearTimeout(budgetTimer);
            budgetTimer = setTimeout(reencode, 140);
        });
    });

    modalX.addEventListener('click', closePayment);
    modal.addEventListener('click', (e) => { if (e.target === modal) closePayment(); });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // The preview sits above the payment modal, so it closes first and alone.
        if (!imgView.hidden) { closeImageView(); return; }
        closePayment();
    });

    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(modalAddress.textContent).then(() => {
            copyBtn.textContent = 'Copied';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
        }).catch(() => {});
    });

    // --- Init --------------------------------------------------------------
    imgBudgetN.textContent = fmt(parseInt(imgBudget.value, 10) || 0);
    recalc();
    renderOrders();
    loadWall();
    openApiIfHashed();
    poll();
    setInterval(poll, 5000);
    setInterval(loadWall, 60000);
});
