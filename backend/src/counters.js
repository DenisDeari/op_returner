// backend/src/counters.js
//
// Daily aggregate counts of a few named events. Nothing else.
//
// WHAT THIS IS FOR. Two of every three requests ever created were never paid — 24 of them
// at the time of writing — and the service could not say why, because it could not say
// what happened BEFORE the row existed. A `requests` row is only created when the customer
// has already seen the full price and clicked through, so "they balked at the cost" and
// "they never found the site" are indistinguishable from the database alone. These counters
// close that gap: home_view against the number of rows created is the visit-to-quote rate,
// and pay_opened/address_copied against paid rows is what happens after the quote.
//
// WHAT THIS IS NOT. It is not analytics about people. There is no identifier here of any
// kind — no IP, no cookie, no session, no user agent, no referrer, no path. A count is an
// integer per day per event name, and the most it can ever tell you is "this happened N
// times". That is a deliberate ceiling, not a first version: anything that could single a
// visitor out would make this a tracking system, which needs a banner, a policy and a legal
// basis, and would be a strange thing to bolt onto a service whose selling point is that it
// takes no account and no signup.
//
// The numbers are approximate on purpose, and must never be used for anything that has to
// be exact:
//   - /api/beacon is unauthenticated, so a bored person can inflate any client-side count.
//     Rate-limited, but not attested. home_view is server-side and therefore harder to
//     forge, though a crawler still counts as a visit.
//   - Counts live in memory between flushes and are LOST on restart or crash. A deploy
//     drops up to FLUSH_INTERVAL_MS of counting. Accepted: the alternative is an fsync per
//     page view on the same serialized handle the money paths use, and schema.js is
//     explicit that chatty writes there slow down a transaction build.
//
// Money decisions read `requests`. This table is for deciding what to change on a website.

const { dbAll, dbRun } = require('./db_utils');

/**
 * The events that may be counted, and the only strings /api/beacon will accept.
 *
 * An allowlist rather than free text, because the endpoint is public: without it, anyone
 * could write unbounded distinct rows into the table through a POST body.
 */
const EVENTS = Object.freeze({
    /** A render of the homepage. Server-side; includes crawlers. */
    HOME_VIEW: 'home_view',
    /** The payment panel was opened for a quote that had just been created. */
    PAY_OPENED: 'pay_opened',
    /** The payment address or the BIP21 URI was copied to the clipboard. */
    ADDRESS_COPIED: 'address_copied',
});

const EVENT_NAMES = Object.freeze(new Set(Object.values(EVENTS)));

/** How often the in-memory counts are written out. One write per event name per flush. */
const FLUSH_INTERVAL_MS = 60 * 1000;

/** day -> name -> count, for counts not yet written to the database. */
const pending = new Map();

function isKnownEvent(name) {
    return EVENT_NAMES.has(name);
}

/** UTC, so a day boundary is the same one everywhere and does not move with the host. */
function today() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Records one occurrence of `name`.
 *
 * Silently ignores an unknown name and never throws. Call sites are page renders and API
 * handlers; counting must not be able to fail a request that was otherwise fine.
 */
function bump(name, amount = 1) {
    try {
        if (!isKnownEvent(name)) return;
        const n = Number.isFinite(amount) ? Math.floor(amount) : 0;
        if (n <= 0) return;

        const day = today();
        const forDay = pending.get(day) || new Map();
        forDay.set(name, (forDay.get(name) || 0) + n);
        pending.set(day, forDay);
    } catch { /* a counter must never break its caller */ }
}

/**
 * Writes the accumulated counts and empties the buffer.
 *
 * The buffer is taken and cleared BEFORE the first await, so counts arriving during the
 * flush land in the next one rather than being dropped by the clear. If a write fails, its
 * counts are added back so the next flush retries them — the one case worth the complexity,
 * because a locked database during a treasury spend is normal and would otherwise silently
 * eat a minute of data.
 */
async function flush(db) {
    if (!db || pending.size === 0) return 0;

    const batch = [...pending.entries()].map(([day, counts]) => [day, [...counts.entries()]]);
    pending.clear();

    let written = 0;
    for (const [day, counts] of batch) {
        for (const [name, count] of counts) {
            try {
                await dbRun(db, UPSERT_SQL, [day, name, count]);
                written += 1;
            } catch (e) {
                const forDay = pending.get(day) || new Map();
                forDay.set(name, (forDay.get(name) || 0) + count);
                pending.set(day, forDay);
                console.warn(`[Counters] Deferred ${name} for ${day}: ${e.message}`);
            }
        }
    }
    return written;
}

// ON CONFLICT ... DO UPDATE, so a flush adds to the day's running total rather than
// replacing it. `excluded.count` is this statement's value, `count` the stored one.
const UPSERT_SQL = `
    INSERT INTO daily_counters (day, name, count)
         VALUES (?, ?, ?)
    ON CONFLICT(day, name) DO UPDATE SET count = count + excluded.count
`;

/**
 * The last `days` days of counts, newest day first, with the unflushed buffer folded in so
 * a number the operator just generated by loading the page is visible immediately.
 *
 * @returns {Promise<Array<{day: string, counts: object}>>}
 */
async function read(db, days = 30) {
    const n = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

    const rows = await dbAll(
        db,
        'SELECT day, name, count FROM daily_counters WHERE day >= ? ORDER BY day DESC',
        [since],
    );

    const byDay = new Map();
    for (const r of rows || []) {
        const counts = byDay.get(r.day) || {};
        counts[r.name] = (counts[r.name] || 0) + r.count;
        byDay.set(r.day, counts);
    }
    for (const [day, counts] of pending) {
        if (day < since) continue;
        const merged = byDay.get(day) || {};
        for (const [name, count] of counts) merged[name] = (merged[name] || 0) + count;
        byDay.set(day, merged);
    }

    return [...byDay.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([day, counts]) => ({ day, counts }));
}

/** Test seam: drops the buffer without writing it. */
function reset() {
    pending.clear();
}

module.exports = {
    bump,
    flush,
    read,
    reset,
    isKnownEvent,
    EVENTS,
    EVENT_NAMES,
    FLUSH_INTERVAL_MS,
    UPSERT_SQL,
};
