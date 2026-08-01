// backend/src/routes/wallet.js
//
// Admin-only, read-only wallet API.
//
// Nothing in this router signs or broadcasts anything. It derives addresses from the
// seed, asks block explorers for balances, and draws QR codes. Keep it that way: the
// moment a spend endpoint lives here, the whole file becomes a money path and needs the
// idempotency and locking care that refund.js has.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const walletScan = require('../wallet_scan');
const qr = require('../qr');
const { requireAdmin } = require('./auth');

const MAX_WATCHED_BRANCHES = 25;
const MAX_LABEL_LENGTH = 60;

function createWalletRouter(db, rootNode, config) {
    const router = express.Router();
    const protect = requireAdmin(config);

    /**
     * Validates the path/type/mode trio that both the scanner and the watchlist take.
     * @returns {{ok: true, spec: object} | {ok: false, error: string}}
     */
    function parseBranchSpec(body) {
        const normalized = walletScan.normalizePath(body && body.path);
        if (!normalized.ok) return { ok: false, error: normalized.reason };

        const type = (body && body.type) || 'p2wpkh';
        if (type !== 'all' && !Object.prototype.hasOwnProperty.call(walletScan.ADDRESS_TYPES, type)) {
            return { ok: false, error: `Unknown address type "${type}".` };
        }

        const mode = (body && body.mode) === 'single' ? 'single' : 'branch';
        if (mode === 'branch' && normalized.depth === 0) {
            return { ok: false, error: 'Scanning every child of the master key is not useful. Give at least one level, e.g. m/84\'/0\'/0\'/2' };
        }

        const rawLabel = body && body.label ? String(body.label).trim() : '';
        // Stored and later rendered in the panel, so it is length-capped and stripped of
        // control characters here rather than trusted at display time.
        const label = rawLabel.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_LABEL_LENGTH);

        return { ok: true, spec: { path: normalized.path, type, mode, label, depth: normalized.depth } };
    }

    /**
     * GET /api/admin/wallet/overview
     * Every branch the service uses, plus anything on the watchlist, with totals.
     * ?refresh=1 bypasses the balance cache.
     */
    router.get('/overview', protect, async (req, res) => {
        try {
            const overview = await walletScan.scanWallet(db, rootNode, config, {
                refresh: req.query.refresh === '1' || req.query.refresh === 'true',
            });
            res.json(overview);
        } catch (error) {
            console.error('[Wallet] Overview failed:', error.message);
            res.status(500).json({ error: `Could not read the wallet: ${error.message}` });
        }
    });

    /**
     * POST /api/admin/wallet/scan
     * One-off look at any derivation path, without saving it.
     *
     * This is the answer to "my other service uses a different path and Electrum cannot
     * see it": Electrum only ever scans an account's /0 and /1 branches, so anything
     * else is invisible there but visible here.
     *
     * body: { path, type?: 'p2wpkh'|'p2tr'|'p2sh_p2wpkh'|'p2pkh'|'all', mode?: 'branch'|'single' }
     */
    router.post('/scan', protect, async (req, res) => {
        const parsed = parseBranchSpec(req.body);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });

        const { spec } = parsed;
        try {
            const requestIndex = await walletScan.loadRequestIndex(db);
            // "all" means the operator does not know which script type the other tool
            // used. Trying four types multiplies the number of lookups, so the gap limit
            // is tightened to keep a single click from firing off hundreds of requests.
            const types = spec.type === 'all'
                ? Object.keys(walletScan.ADDRESS_TYPES)
                : [spec.type];
            const gapLimit = spec.type === 'all' ? 5 : config.WALLET_GAP_LIMIT;

            const results = [];
            for (const type of types) {
                const branch = {
                    id: `scan-${type}`,
                    label: spec.label || `${spec.path} — ${walletScan.ADDRESS_TYPES[type]}`,
                    path: spec.path,
                    type,
                    mode: spec.mode,
                };
                const scan = spec.mode === 'single'
                    ? await walletScan.scanSingle(rootNode, branch, config, { refresh: true })
                    : await walletScan.scanBranch(rootNode, branch, config, { refresh: true, gapLimit });
                results.push(walletScan.summariseBranch(branch, scan, requestIndex));
            }

            const found = results.reduce((sum, r) => sum + r.total, 0);
            res.json({
                path: spec.path,
                mode: spec.mode,
                requestedType: spec.type,
                gapLimit,
                results,
                total: found,
                anyFunds: found !== 0,
                anyHistory: results.some((r) => r.usedCount > 0),
            });
        } catch (error) {
            console.error('[Wallet] Scan failed:', error.message);
            res.status(500).json({ error: `Scan failed: ${error.message}` });
        }
    });

    /** GET /api/admin/wallet/watchlist — the saved custom paths. */
    router.get('/watchlist', protect, async (req, res) => {
        try {
            res.json({
                watchlist: await walletScan.getWatchedBranches(db),
                addressTypes: walletScan.ADDRESS_TYPES,
                account: walletScan.accountPath(config),
            });
        } catch (error) {
            res.status(500).json({ error: `Could not read the watchlist: ${error.message}` });
        }
    });

    /**
     * POST /api/admin/wallet/watchlist
     * Adds a path to the permanent overview, so a balance outside the service's own
     * branches is counted in the totals from then on instead of needing a manual scan.
     */
    router.post('/watchlist', protect, async (req, res) => {
        const parsed = parseBranchSpec(req.body);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        // 'all' would mean four branches under one entry; the watchlist stores one type
        // per entry so the operator can remove them individually.
        if (parsed.spec.type === 'all') {
            return res.status(400).json({ error: 'Pick one address type to watch permanently.' });
        }

        try {
            const watchlist = await walletScan.getWatchedBranches(db);
            if (watchlist.length >= MAX_WATCHED_BRANCHES) {
                return res.status(400).json({ error: `The watchlist is full (${MAX_WATCHED_BRANCHES} entries).` });
            }
            const duplicate = watchlist.find(
                (w) => w.path === parsed.spec.path && w.type === parsed.spec.type && w.mode === parsed.spec.mode
            );
            if (duplicate) {
                return res.status(409).json({ error: 'That path is already on the watchlist.' });
            }

            const entry = {
                id: uuidv4(),
                label: parsed.spec.label || `Custom: ${parsed.spec.path}`,
                path: parsed.spec.path,
                type: parsed.spec.type,
                mode: parsed.spec.mode,
                builtIn: false,
                note: parsed.spec.mode === 'single'
                    ? 'Watching this exact address.'
                    : 'Watching every address under this path.',
                addedAt: new Date().toISOString(),
            };
            watchlist.push(entry);
            await walletScan.saveWatchedBranches(db, watchlist);
            console.log(`[Wallet] Watchlist entry added: ${entry.path} (${entry.type}, ${entry.mode})`);
            res.status(201).json({ success: true, entry, watchlist });
        } catch (error) {
            console.error('[Wallet] Watchlist add failed:', error.message);
            res.status(500).json({ error: `Could not save: ${error.message}` });
        }
    });

    /** DELETE /api/admin/wallet/watchlist/:id — stops watching. Never touches coins. */
    router.delete('/watchlist/:id', protect, async (req, res) => {
        try {
            const watchlist = await walletScan.getWatchedBranches(db);
            const remaining = watchlist.filter((w) => w.id !== req.params.id);
            if (remaining.length === watchlist.length) {
                return res.status(404).json({ error: 'No such watchlist entry.' });
            }
            await walletScan.saveWatchedBranches(db, remaining);
            res.json({ success: true, watchlist: remaining });
        } catch (error) {
            res.status(500).json({ error: `Could not remove: ${error.message}` });
        }
    });

    /**
     * GET /api/admin/wallet/qr.svg?address=…&amount=…&label=…
     * A scannable BIP21 code for topping the wallet up from a phone.
     *
     * The address is re-derived from the requested path rather than echoed back from the
     * query string wherever possible, so a QR code can only ever point at an address this
     * seed actually controls.
     */
    router.get('/qr.svg', protect, async (req, res) => {
        try {
            let address = null;

            if (req.query.path) {
                const normalized = walletScan.normalizePath(req.query.path);
                if (!normalized.ok) return res.status(400).json({ error: normalized.reason });
                const type = req.query.type || 'p2wpkh';
                if (!Object.prototype.hasOwnProperty.call(walletScan.ADDRESS_TYPES, type)) {
                    return res.status(400).json({ error: `Unknown address type "${type}".` });
                }
                address = walletScan.deriveAddress(rootNode, normalized.path, type, config.NETWORK);
            } else if (req.query.address) {
                address = String(req.query.address).trim();
                // Rendering an arbitrary string would turn this into an open QR generator
                // that produces codes carrying the admin's own domain. Only real addresses.
                if (!/^[a-zA-Z0-9]{20,90}$/.test(address)) {
                    return res.status(400).json({ error: 'That does not look like a Bitcoin address.' });
                }
            } else {
                return res.status(400).json({ error: 'Give either a path or an address.' });
            }

            const amountSats = req.query.amount ? Number(req.query.amount) : 0;
            if (req.query.amount && (!Number.isFinite(amountSats) || amountSats < 0)) {
                return res.status(400).json({ error: 'Invalid amount.' });
            }

            const label = req.query.label ? String(req.query.label).slice(0, MAX_LABEL_LENGTH) : '';
            const uri = qr.buildPaymentUri(address, { amountSats, label });
            const svg = qr.toSvg(uri, { scale: req.query.scale });

            res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Payment-Uri', uri);
            res.send(svg);
        } catch (error) {
            console.error('[Wallet] QR generation failed:', error.message);
            res.status(500).json({ error: `Could not draw the QR code: ${error.message}` });
        }
    });

    return router;
}

module.exports = createWalletRouter;
