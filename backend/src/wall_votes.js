// backend/src/wall_votes.js
//
// Upvotes on the public wall. Added 2026-11-11 on the operator's decision.
//
// WHAT A VOTE IS. Free, anonymous, one per voter per message, and undoable. There is no
// account on this site and there will not be one for this, so "one per voter" means one per
// client address — the same definition every limiter in the service already uses
// (http_hygiene.js clientIp: Cloudflare's header, else the socket, never X-Forwarded-For).
// That is a soft rule and is meant to be: a household behind one address gets one vote, and
// somebody hopping between mobile networks gets several. It ranks a wall of strangers'
// messages; it does not move money, and nothing anywhere may ever branch on it.
//
// WHAT IS STORED. Not the address. `voter` is HMAC-SHA256(key, bucket) cut to 128 bits,
// where `bucket` is the IPv4 address or the /64 of an IPv6 one (privacy addresses rotate
// inside a /64 every few hours, so the full address would be a new voter each day), and
// `key` is 32 random bytes created on first use and kept in system_settings. Without the key
// the column cannot be reversed by trying all 4 billion IPv4 addresses, which a plain hash
// could be in minutes. The key never leaves the database.
//
// WHAT IT TOUCHES. Only wall_votes, and a read of `requests` through the wall's own
// predicate (wall.WALL_EXISTS_SQL) so a hidden, withdrawn or redacted message cannot be voted
// on. Every refusal looks the same as "no such message" — see wall.js on oracles.
//
// WHAT BOUNDS IT. The route's per-address rate limit (routes/api.js). Each accepted vote is
// one INSERT on the serialized handle the money paths share, in journal_mode=delete, so it is
// an fsync; the limiter keeps that a trickle no matter who is clicking.

const crypto = require('crypto');
const { dbGet, dbRun } = require('./db_utils');
const wall = require('./wall');

const KEY_SETTING = 'wall_vote_key';

let keyPromise = null;

/**
 * The HMAC key, created once and then read back forever.
 *
 * INSERT OR IGNORE then SELECT, rather than generate-and-use: two first votes racing each
 * other must end up with the same key, and only the row that won the insert is the key.
 * A failure is not cached, so the next vote tries again.
 */
function voterKey(db) {
    if (!keyPromise) {
        keyPromise = (async () => {
            await dbRun(db, 'INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)',
                [KEY_SETTING, crypto.randomBytes(32).toString('hex')]);
            const row = await dbGet(db, 'SELECT value FROM system_settings WHERE key = ?', [KEY_SETTING]);
            if (!row || !/^[0-9a-f]{64}$/.test(row.value)) throw new Error('vote key unavailable');
            return Buffer.from(row.value, 'hex');
        })().catch((e) => { keyPromise = null; throw e; });
    }
    return keyPromise;
}

/**
 * The part of a client address that identifies a voter.
 *
 * IPv4 (including the IPv4-mapped IPv6 form Node reports on a dual-stack socket) as is; IPv6
 * cut to its first four hextets. Anything unparseable is used verbatim — it still hashes to
 * something stable, and an attacker gains nothing by sending garbage they cannot choose.
 */
function voterBucket(ip) {
    let a = String(ip || '').trim().toLowerCase();
    if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7);
    if (!a.includes(':')) return a;

    // Expand "::" so the first four groups are the real first four groups.
    const [head, tail] = a.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
    const groups = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
    return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

async function voterId(db, ip) {
    const key = await voterKey(db);
    return crypto.createHmac('sha256', key).update(voterBucket(ip)).digest('hex').slice(0, 32);
}

async function countVotes(db, txid) {
    const row = await dbGet(db, 'SELECT COUNT(*) AS n FROM wall_votes WHERE opReturnTxId = ?', [txid]);
    return row ? row.n : 0;
}

/**
 * Casts (up = true) or withdraws (up = false) one voter's vote on one wall message.
 *
 * Returns { votes, voted } on success, or null for EVERY refusal — a malformed txid, a txid
 * that is not ours, a message that is hidden, withdrawn or redacted — so the caller answers
 * them all with the same 404.
 *
 * Idempotent both ways: voting twice is one vote, withdrawing a vote that does not exist is
 * nothing. `changed` says whether a row was actually written, so the caller only drops the
 * wall cache when the count really moved.
 */
async function castVote(db, opReturnTxId, ip, up) {
    const txid = String(opReturnTxId || '').toLowerCase();
    if (!wall.TXID_RE.test(txid)) return null;

    const onWall = await dbGet(db, wall.WALL_EXISTS_SQL, [txid]);
    if (!onWall) return null;

    const voter = await voterId(db, ip);
    const result = up
        ? await dbRun(db, 'INSERT OR IGNORE INTO wall_votes (opReturnTxId, voter, at) VALUES (?, ?, ?)',
            [txid, voter, new Date().toISOString()])
        : await dbRun(db, 'DELETE FROM wall_votes WHERE opReturnTxId = ? AND voter = ?', [txid, voter]);

    return { votes: await countVotes(db, txid), voted: !!up, changed: result.changes > 0 };
}

module.exports = {
    castVote,
    voterBucket,
    voterId,
    countVotes,
    KEY_SETTING,
    // For the test harness: forget the cached key so a fresh database gets a fresh one.
    _resetKeyCache: () => { keyPromise = null; },
};
