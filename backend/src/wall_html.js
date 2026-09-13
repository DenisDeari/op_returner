// backend/src/wall_html.js
//
// The server-rendered copy of the public wall.
//
// WHY THIS EXISTS. The wall is the only content on satwire.io that grows, and until this
// module it was invisible to everything that does not run JavaScript. index.html shipped
// an empty `<div id="wall">` and app.js filled it from /api/wall after load, so Googlebot,
// every link preview, every answer engine and every reader-mode saw a page with 149 words
// on it and no messages at all. The static prose lower down the page was written to
// compensate for exactly that, and is no longer the only thing a crawler gets.
//
// The client still renders the wall on top of this on every load. That is deliberate and
// not a duplication to remove: app.js polls /api/wall once a minute and needs the DOM it
// builds itself, and the server copy has to survive a cached HTML response that may be up
// to CACHE_MS stale. First paint comes from here; everything after it comes from app.js.
//
// THIS MODULE IS AN XSS SURFACE AND NOTHING ELSE IT DOES MATTERS AS MUCH.
//
// Everywhere else in the service, customer text reaches the browser through `textContent`
// or a DOM-built node, so it never passes the HTML parser — see the invariant table in
// CLAUDE.md and renderWall() in frontend/js/app.js, which says so in its own comment. A
// server-rendered string cannot use that trick: it IS markup, and the escaper is the only
// thing standing between a stranger's 1,000 bytes and the origin that serves /admin.
//
// So the rules here are narrow on purpose:
//
//   - Every value interpolated into HTML goes through escapeHtml(). No exceptions, not
//     for values that "cannot" contain markup — payloadKind is our own enum today and a
//     one-line change away from not being.
//   - The only customer-controlled text that reaches the output is `message`, and only
//     for TEXT rows. Image rows never carry their bytes here (the listing query drops
//     them) and are rendered as an <img> pointing at the payload endpoint, keyed on a
//     txid that must match /^[0-9a-f]{64}$/ before it is used.
//   - No attribute is built from a customer value except that validated txid.
//   - Nothing here reads the database. It is handed rows and returns a string, which is
//     what makes it testable at all — wall.js owns the predicate, this owns the markup.
//
// The markup mirrors renderWall() in frontend/js/app.js closely enough that the client's
// re-render is not a visible reflow. If you change a class name in one, change it in both.

/** Mirror of RENDERABLE_KINDS in frontend/js/app.js. Inert raster only — never SVG. */
const IMAGE_KINDS = new Set(['image/webp', 'image/jpeg']);

/** A Bitcoin txid and nothing else. Checked before a txid is put in an attribute. */
const TXID_RE = /^[0-9a-f]{64}$/;

const ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/**
 * HTML-escapes a value for both text and attribute contexts.
 *
 * Both quote styles are escaped so the same function is safe in an unquoted-by-accident
 * attribute, and `&` is escaped first by virtue of being in the same pass — a two-pass
 * escaper that replaces `&` after `<` produces `&amp;lt;`.
 */
function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * The date a card shows before JavaScript replaces it with a relative one.
 *
 * Absolute, not "2d ago", for two reasons: this HTML can be served from a cache minutes
 * after it was built, and a crawler reading "2d ago" learns nothing it can date. The
 * machine-readable value goes in `datetime`, which is what a parser reads anyway.
 */
function formatWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { text: '', attr: '' };
    const text = d.toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
    return { text, attr: d.toISOString() };
}

/**
 * One wall card.
 *
 * Returns '' for a row that carries neither renderable text nor a usable txid, so a
 * malformed row drops out of the page instead of rendering an empty box.
 */
function renderCard(row) {
    const kind = row && row.payloadKind;
    const txid = String((row && row.opReturnTxId) || '').toLowerCase();
    const hasTxid = TXID_RE.test(txid);
    const isImage = IMAGE_KINDS.has(kind);

    // An image row without a valid txid has nothing to point an <img> at, and its bytes
    // are deliberately not in the listing. Nothing to draw.
    if (isImage && !hasTxid) return '';

    let body;
    if (isImage) {
        // `loading="lazy"` matters more here than in the client render: this markup is in
        // the initial HTML, so without it every published image is a blocking request on
        // first paint.
        body = `<p><img class="payload-img" loading="lazy" decoding="async"`
            + ` src="/api/wall/payload/${escapeHtml(txid)}"`
            + ` alt="A picture published on the Bitcoin blockchain"></p>`;
    } else {
        const text = String((row && row.message) || '');
        if (!text) return '';
        body = `<p>${escapeHtml(text)}</p>`;
    }

    // The date links to the message's own page at /m/<txid>. That link is the only thing
    // pointing a crawler at those pages from anywhere on the site, so it must be a real
    // <a href> in the server-rendered HTML — a click handler would be invisible to one.
    const when = formatWhen(row && row.publishedAt);
    const whenHtml = when.text
        ? (hasTxid
            ? `<a class="card-date" href="/m/${escapeHtml(txid)}">`
                + `<time datetime="${escapeHtml(when.attr)}">${escapeHtml(when.text)}</time></a>`
            : `<time datetime="${escapeHtml(when.attr)}">${escapeHtml(when.text)}</time>`)
        : '<span></span>';

    // rel="noopener nofollow" — noopener for the usual reason, nofollow because the link
    // target is chosen by whoever paid for the message. It is a fixed explorer domain
    // today; nofollow costs nothing and keeps it from ever being a ranking gift.
    const linkHtml = hasTxid
        ? `<a href="https://mempool.space/tx/${escapeHtml(txid)}" target="_blank"`
            + ` rel="noopener nofollow">tx ↗</a>`
        : '';

    return `<article class="note-card${isImage ? ' is-image' : ''}">`
        + body
        + `<footer>${whenHtml}${linkHtml}</footer>`
        + `</article>`;
}

/**
 * The inner HTML of `#wall`, and the text of `#wall-n`.
 *
 * @param {object[]} messages rows as returned by wall.listPublicMessages
 * @returns {{cards: string, count: string}}
 */
function renderWall(messages) {
    const rows = Array.isArray(messages) ? messages : [];
    const cards = rows.map(renderCard).filter(Boolean);

    if (!cards.length) {
        // Same words the client shows for an empty wall, so the two cannot disagree about
        // what "nothing here" looks like.
        return { cards: '<p class="wall-empty">Nothing here yet. Yours could be first.</p>', count: '' };
    }

    return { cards: cards.join(''), count: `${cards.length} published` };
}

// The two markers in index.html this module fills. Matched as exact strings rather than
// with a parser: a regex over HTML is a bug generator, and an empty element written by
// hand in a file in this repo is not going to drift without someone editing it.
const WALL_MARKER = '<div class="wall" id="wall"></div>';
const COUNT_MARKER = '<span class="meta" id="wall-n"></span>';

/**
 * Injects the rendered wall into the homepage HTML.
 *
 * Returns the template UNCHANGED if either marker is missing. That is the important
 * behaviour: the homepage is the composer, the composer is how the service takes money,
 * and a renaming of a div must degrade to "the wall is client-rendered again", never to a
 * 500 on the front page.
 */
function injectWall(templateHtml, messages) {
    const html = String(templateHtml || '');
    if (!html.includes(WALL_MARKER) || !html.includes(COUNT_MARKER)) return html;

    const { cards, count } = renderWall(messages);

    return html
        .replace(WALL_MARKER, `<div class="wall" id="wall">${cards}</div>`)
        .replace(COUNT_MARKER, `<span class="meta" id="wall-n">${escapeHtml(count)}</span>`);
}

module.exports = {
    injectWall,
    renderWall,
    renderCard,
    escapeHtml,
    formatWhen,
    IMAGE_KINDS,
    TXID_RE,
    WALL_MARKER,
    COUNT_MARKER,
};
