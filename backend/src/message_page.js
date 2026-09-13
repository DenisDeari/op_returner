// backend/src/message_page.js
//
// The page for ONE published message, at /m/<txid>.
//
// WHY A PAGE PER MESSAGE. Until this, satwire.io was a single URL. A search engine ranks
// pages, not sites, so one URL is one chance to appear in a result no matter how much
// content sits on it — and the wall's content is the only content here that grows. Every
// published message is unique text nobody else on the internet has, permanently attached
// to a verifiable transaction. This turns each one into its own page, and it gives a
// customer a link to their message that is not a block explorer.
//
// THE URL IS KEYED ON THE TXID, never on the request id. A request id is a bearer
// capability — GET /api/request-status/:id is public — so a page whose address contained
// one would hand every visitor read access to that order. The txid is already public: it
// is on the chain, on the wall card, and in the sitemap. Same reasoning as the payload
// endpoint in wall.js, and it must stay that way.
//
// REFUSALS ARE ALL IDENTICAL. wall.findPublicMessage runs WALL_WHERE_SQL, so a message
// that is hidden, withdrawn, redacted or simply not ours all come back the same: null. The
// route renders the same 404 for every one of them. A page that 404s differently for
// "exists but hidden" is a moderation oracle a person can read, which is worse than the
// machine-readable one the payload endpoint was careful to avoid.
//
// ESCAPING: this is the same XSS surface as wall_html.js and follows the same rule — every
// value interpolated into HTML goes through escapeHtml first, no exceptions. Substitution
// is a SINGLE regex pass over the template, so a message containing the literal text
// `{{TITLE}}` cannot cause a second substitution: replaced content is never re-scanned.

const wallHtml = require('./wall_html');
const payload = require('./payload');

/** Escaping, date formatting and the image allowlist are shared with the wall renderer. */
const { escapeHtml, formatWhen, IMAGE_KINDS, TXID_RE } = wallHtml;

/**
 * The shortest text message that gets its own indexable page.
 *
 * Not arbitrary. Real published messages include "test" and "Hjjhggj"; a page whose entire
 * content is four bytes is what a search engine calls a thin page, and a site made mostly
 * of them is judged as a whole, so the thin ones would drag down the good ones. Below this,
 * the page is still served and still works — a customer who wants to share their four-byte
 * message can — it just carries `noindex` and stays out of the sitemap.
 *
 * Measured in ON-CHAIN bytes, via payload.byteLength, for the same reason everything else
 * is: an image row's `message` column is base64 and a third larger than what it publishes.
 */
const MIN_INDEXABLE_BYTES = 40;

/** How much of a message becomes the <title> and the meta description. */
const TITLE_CHARS = 60;
const DESCRIPTION_CHARS = 155;

/**
 * Should this message have an indexable page?
 *
 * Images always qualify: the page has a picture on it, which is not thin whatever its byte
 * count. Text qualifies on length alone.
 *
 * The ONE place this rule lives. The page renderer uses it to decide `robots`, and the
 * sitemap uses it to decide what to list — a sitemap that advertises a page carrying
 * `noindex` is a contradiction a crawler reports back as an error.
 */
function isIndexable(row) {
    if (!row) return false;
    if (IMAGE_KINDS.has(row.payloadKind)) return true;
    try {
        return payload.byteLength(row.message, row.payloadKind) >= MIN_INDEXABLE_BYTES;
    } catch {
        return false;
    }
}

/**
 * A single-line excerpt of a message, collapsed and cut on a word boundary where it can be.
 *
 * Runs on the RAW text and returns raw text — the caller escapes. Doing it the other way
 * round would cut through an entity and produce `&am`.
 */
function excerpt(text, maxChars) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (flat.length <= maxChars) return flat;
    const cut = flat.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The values for one message's page.
 *
 * @param {object} row from wall.findPublicMessage
 * @param {string} baseUrl e.g. https://satwire.io, no trailing slash
 */
function buildTokens(row, baseUrl) {
    const txid = String(row.opReturnTxId || '').toLowerCase();
    const isImage = IMAGE_KINDS.has(row.payloadKind);
    const when = formatWhen(row.publishedAt);
    const canonical = `${baseUrl}/m/${txid}`;

    const text = isImage ? '' : String(row.message || '');
    const headline = isImage
        ? 'A picture published on the Bitcoin blockchain'
        : excerpt(text, TITLE_CHARS);

    // The description says what the page IS as well as what it holds. A description that
    // is only the message reads, in a result list, like a page about nothing.
    const description = isImage
        ? `A picture published permanently in a Bitcoin OP_RETURN output on ${when.text}.`
        : `“${excerpt(text, DESCRIPTION_CHARS)}” — published permanently in a Bitcoin OP_RETURN output on ${when.text}.`;

    const body = isImage
        ? `<img class="payload-img" src="/api/wall/payload/${txid}" loading="eager" decoding="async"`
            + ` alt="A picture published on the Bitcoin blockchain">`
        : `<p>${escapeHtml(text)}</p>`;

    // An image message previews as itself; everything else falls back to the brand card.
    const ogImage = isImage ? `${baseUrl}/api/wall/payload/${txid}` : `${baseUrl}/og.png`;

    const blockRow = Number.isFinite(row.opReturnBlockHeight) && row.opReturnBlockHeight
        ? `<dt>Block</dt><dd><a href="https://mempool.space/block/${escapeHtml(String(row.opReturnBlockHeight))}"`
            + ` target="_blank" rel="noopener nofollow">${escapeHtml(Number(row.opReturnBlockHeight).toLocaleString('en-GB'))}</a></dd>`
        : '';

    return {
        TITLE: `${headline} — SatWire`,
        OG_TITLE: headline,
        DESCRIPTION: description,
        // max-image-preview:large so an image message can preview at full size in a result.
        ROBOTS: isIndexable(row) ? 'index, follow, max-image-preview:large' : 'noindex, follow',
        CANONICAL: canonical,
        OG_IMAGE: ogImage,
        BODY: body,
        BLOCK_ROW: blockRow,
        TXID: txid,
        PUBLISHED_ISO: when.attr,
        PUBLISHED_TEXT: when.text,
    };
}

/**
 * Fills the template.
 *
 * BODY and BLOCK_ROW are already-built markup, escaped when they were built; every other
 * token is escaped here. An unknown token is left in the template untouched rather than
 * blanked, so the `{{TOKEN}}` in the template's own comment survives and a typo in a token
 * name is visible instead of silent.
 */
function renderMessagePage(templateHtml, row, baseUrl) {
    const tokens = buildTokens(row, baseUrl);
    const raw = new Set(['BODY', 'BLOCK_ROW']);

    return String(templateHtml || '').replace(/\{\{([A-Z_]+)\}\}/g, (match, name) => {
        if (!Object.prototype.hasOwnProperty.call(tokens, name)) return match;
        return raw.has(name) ? tokens[name] : escapeHtml(tokens[name]);
    });
}

/**
 * The page for a txid that has nothing to show, whatever the reason.
 *
 * Self-contained rather than templated: it must render even if the template file is the
 * thing that is missing. `noindex` because a 404 that gets indexed is a 404 in somebody's
 * search results.
 */
function renderNotFound() {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Message not found — SatWire</title>
<meta name="robots" content="noindex, follow">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="stylesheet" href="/css/styles.css?v=15">
</head><body><div class="wrap">
<section class="sec info" style="margin-top:80px">
<div class="sec-head"><h2>Nothing to show here</h2></div>
<p>This transaction has no message on SatWire. It may never have had one, or it may not be
published on the wall.</p>
<p><a class="cta-link" href="/">Write a message on the blockchain &rarr;</a></p>
</section>
<footer class="foot"><span>SatWire</span><span><a href="/what-is-op-return">What is OP_RETURN?</a></span></footer>
</div></body></html>`;
}

module.exports = {
    renderMessagePage,
    renderNotFound,
    buildTokens,
    isIndexable,
    excerpt,
    MIN_INDEXABLE_BYTES,
    TITLE_CHARS,
    DESCRIPTION_CHARS,
    TXID_RE,
};
