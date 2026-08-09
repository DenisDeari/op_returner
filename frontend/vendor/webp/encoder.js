// frontend/vendor/webp/encoder.js
//
// A WebP encoder that does not depend on the browser having one.
//
// WHY THIS EXISTS. The composer encodes the customer's picture in their own browser, so
// that no image decoder ever runs on the machine holding the wallet seed. That decision is
// right and stays. But it was implemented as "whatever `canvas.toBlob` can produce", and
// a browser without native WebP encoding silently fell back to JPEG — which is roughly
// TWICE the bytes for the same picture at these sizes. The customer paid double for the
// same image, and the only sign was a line of small print.
//
// This is libwebp itself, compiled to WebAssembly, so every browser gets WebP. The
// security property is unchanged: it runs in the customer's browser, in the WASM sandbox,
// and touches nothing of ours.
//
// PROVENANCE — this is vendored third-party code in a repository that moves money:
//   @jsquash/webp 1.5.0, Apache-2.0, https://github.com/jamsinclair/jSquash
//   The codec is Google's libwebp as built for Squoosh (squoosh.app).
//   Vendored files: webp_enc.js / .wasm and webp_enc_simd.js / .wasm, byte-for-byte from
//   the published package. UPSTREAM-package.json is kept beside them as the record.
//   Only this loader is ours.
//
// Nothing here is on a money path. It produces image bytes, which intake then validates
// like any other payload — length, magic bytes, and the declared type must match.

// libwebp's full WebPConfig struct. The emscripten binding expects every field, not a
// partial object, so this is copied verbatim from the package's meta.js rather than
// trimmed to the two fields we vary.
const DEFAULT_OPTIONS = {
    quality: 75,
    target_size: 0,
    target_PSNR: 0,
    method: 4,
    sns_strength: 50,
    filter_strength: 60,
    filter_sharpness: 0,
    filter_type: 1,
    partitions: 0,
    segments: 4,
    pass: 1,
    show_compressed: 0,
    preprocessing: 0,
    autofilter: 0,
    partition_limit: 0,
    alpha_compression: 1,
    alpha_filtering: 1,
    alpha_quality: 100,
    lossless: 0,
    exact: 0,
    image_hint: 0,
    emulate_jpeg_size: 0,
    thread_level: 0,
    low_memory: 0,
    near_lossless: 100,
    use_delta_palette: 0,
    use_sharp_yuv: 0,
};

/**
 * Does this engine support WASM SIMD?
 *
 * A 45-byte module containing a single v128 instruction: it validates only where SIMD is
 * supported. Inlined rather than pulling in `wasm-feature-detect`, which would be a second
 * third-party package to vet for one boolean.
 *
 * The SIMD build is meaningfully faster, and the budget search runs the encoder many times
 * per slider step, so it is worth the branch.
 */
async function hasSimd() {
    try {
        return WebAssembly.validate(new Uint8Array([
            0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10,
            10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
        ]));
    } catch {
        return false;
    }
}

let modulePromise = null;

/**
 * Loads the codec once, lazily.
 *
 * Deliberately NOT loaded at page load: it is ~280 kB of WebAssembly that most visitors
 * never need, on a page whose job is to show a wall of messages. It is fetched the first
 * time somebody actually attaches an image in a browser that needs it.
 *
 * The emscripten module resolves its own .wasm relative to its own URL, which is why the
 * two files sit side by side in this directory and must stay together.
 */
async function loadCodec() {
    if (modulePromise) return modulePromise;
    modulePromise = (async () => {
        const file = (await hasSimd()) ? './webp_enc_simd.js' : './webp_enc.js';
        const codec = await import(file);
        return codec.default({ noInitialRun: true });
    })().catch((error) => {
        // Do not cache a failure — a transient network problem must not disable the
        // encoder for the rest of the page's life.
        modulePromise = null;
        throw error;
    });
    return modulePromise;
}

/**
 * Encodes raw RGBA pixels as WebP.
 *
 * @param {ImageData} imageData  from canvas ctx.getImageData()
 * @param {number} quality       0..1, matching canvas.toBlob's scale
 * @returns {Promise<Blob>}      image/webp
 */
export async function encodeWebp(imageData, quality) {
    const module = await loadCodec();
    const options = {
        ...DEFAULT_OPTIONS,
        // toBlob takes 0..1, libwebp takes 0..100. Clamped because libwebp rejects values
        // outside its range outright rather than saturating.
        quality: Math.max(0, Math.min(100, Math.round(quality * 100))),
    };
    const result = module.encode(imageData.data, imageData.width, imageData.height, options);
    if (!result) throw new Error('WebP encoding failed');
    // Typed as image/webp here, and intake re-checks the magic bytes against that claim —
    // a label is not evidence.
    return new Blob([result.buffer], { type: 'image/webp' });
}

/** True once the codec is in memory, so callers can avoid a needless await. */
export function isCodecLoaded() {
    return modulePromise !== null;
}
