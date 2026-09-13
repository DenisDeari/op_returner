// backend/src/sitemap.js
//
// /sitemap.xml — the list of pages worth crawling, handed to search engines directly
// rather than left to be discovered by following links.
//
// GENERATED, NOT A FILE. A static sitemap would be a file somebody has to remember to
// update every time a message is published, and the one thing worse than no sitemap is one
// that is quietly six months out of date. This reads the same predicate the wall does, so
// a message that is hidden or withdrawn drops out of the sitemap on the next request.
//
// IT MUST AGREE WITH THE PAGES IT LISTS. A sitemap that advertises a URL carrying a
// `noindex` tag is a contradiction, and Search Console reports it back as an error. So the
// indexable test lives in message_page.js and is imported here rather than re-implemented:
// one rule, two callers. Thin messages are served, and are simply not advertised.

const messagePage = require('./message_page');

/** XML's five predefined entities. The same set as HTML's, and required in every field. */
const XML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
};

function xmlEscape(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/** W3C datetime, date only. A sitemap lastmod does not need the clock. */
function lastmodOf(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function urlEntry({ loc, lastmod, changefreq, priority }) {
    const parts = [`    <loc>${xmlEscape(loc)}</loc>`];
    if (lastmod) parts.push(`    <lastmod>${xmlEscape(lastmod)}</lastmod>`);
    if (changefreq) parts.push(`    <changefreq>${xmlEscape(changefreq)}</changefreq>`);
    if (priority) parts.push(`    <priority>${xmlEscape(priority)}</priority>`);
    return `  <url>\n${parts.join('\n')}\n  </url>`;
}

/**
 * The sitemap for a set of published messages.
 *
 * @param {object[]} rows from wall.listAllPublicMessages, newest first
 * @param {string} baseUrl e.g. https://satwire.io, no trailing slash
 */
function renderSitemap(rows, baseUrl) {
    const messages = (Array.isArray(rows) ? rows : []).filter(messagePage.isIndexable);

    // The homepage's lastmod is the newest message on it: the wall is the part of that page
    // that changes, so claiming a newer date would be a claim about nothing.
    const newest = messages.length ? lastmodOf(messages[0].publishedAt) : null;

    const entries = [
        urlEntry({ loc: `${baseUrl}/`, lastmod: newest, changefreq: 'daily', priority: '1.0' }),
        // No lastmod: the explainer changes when someone edits it, which is not a date this
        // code can know, and a fabricated one teaches a crawler to ignore the field.
        urlEntry({ loc: `${baseUrl}/what-is-op-return`, changefreq: 'monthly', priority: '0.8' }),
    ];

    for (const row of messages) {
        const txid = String(row.opReturnTxId || '').toLowerCase();
        if (!messagePage.TXID_RE.test(txid)) continue;
        entries.push(urlEntry({
            loc: `${baseUrl}/m/${txid}`,
            lastmod: lastmodOf(row.publishedAt),
            // A published message is immutable — that is the product. Saying so stops a
            // crawler re-fetching pages that can never have changed.
            changefreq: 'never',
            priority: '0.6',
        }));
    }

    return `<?xml version="1.0" encoding="UTF-8"?>\n`
        + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
        + `${entries.join('\n')}\n`
        + `</urlset>\n`;
}

module.exports = { renderSitemap, xmlEscape, lastmodOf };
