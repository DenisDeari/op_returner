const express = require('express');

function createHallOfFameRouter(db) {
    const router = express.Router();

    // Initialize table
    db.run(`CREATE TABLE IF NOT EXISTS hall_of_fame (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        description TEXT,
        txId TEXT,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        txDate INTEGER,
        blockHeight INTEGER,
        amount INTEGER
    )`, (err) => {
        if (!err) {
            // Attempt to add columns if they don't exist (for existing DBs)
            db.run(`ALTER TABLE hall_of_fame ADD COLUMN txDate INTEGER`, () => {});
            db.run(`ALTER TABLE hall_of_fame ADD COLUMN blockHeight INTEGER`, () => {});
            db.run(`ALTER TABLE hall_of_fame ADD COLUMN amount INTEGER`, () => {});
        }
    });

    // Public: Get all entries (with auto-repair for missing dates)
    router.get('/', async (req, res) => {
        try {
            // 1. Fetch all rows
            let rows = await new Promise((resolve, reject) => {
                db.all("SELECT * FROM hall_of_fame", [], (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                });
            });

            // 2. Identify rows that need backfilling (missing txDate)
            const incompleteRows = rows.filter(r => !r.txDate || r.txDate === 0);

            if (incompleteRows.length > 0) {
                console.log(`[HallOfFame] Found ${incompleteRows.length} entries needing update. Processing...`);
                
                // Process in parallel but limit concurrency if needed (using Promise.all for now)
                await Promise.all(incompleteRows.map(async (row) => {
                    if (!row.txId) return; // Can't fetch without TXID

                    try {
                        const response = await fetch(`https://mempool.space/api/tx/${row.txId}`);
                        if (!response.ok) return;

                        const txData = await response.json();
                        let txDate = 0;
                        let blockHeight = 0;
                        let amount = 0;

                        if (txData.status) {
                            if (txData.status.block_time) txDate = txData.status.block_time;
                            if (txData.status.block_height) blockHeight = txData.status.block_height;
                        }
                        if (txData.vout) {
                            amount = txData.vout.reduce((acc, out) => acc + (out.value || 0), 0);
                        }

                        // Update DB
                        await new Promise((resolve) => {
                            db.run(
                                "UPDATE hall_of_fame SET txDate = ?, blockHeight = ?, amount = ? WHERE id = ?",
                                [txDate, blockHeight, amount, row.id],
                                (err) => resolve()
                            );
                        });

                        // Update local object for immediate return
                        row.txDate = txDate;
                        row.blockHeight = blockHeight;
                        row.amount = amount;

                    } catch (e) {
                        console.error(`Failed to update row ${row.id}:`, e.message);
                    }
                }));
            }

            // 3. Sort in memory (or re-fetch, but memory is faster here)
            // Sort by txDate ASC (Oldest first)
            rows.sort((a, b) => {
                const dateA = a.txDate || 0;
                const dateB = b.txDate || 0;
                if (dateA !== dateB) return dateA - dateB;
                return new Date(a.createdAt) - new Date(b.createdAt);
            });

            res.status(200).json(rows);
        } catch (error) {
            console.error("Error fetching Hall of Fame:", error);
            res.status(500).json({ error: "Failed to fetch Hall of Fame" });
        }
    });

    // Helper: Decode Hex
    function decodeHex(hex) {
        try {
            const raw = Buffer.from(hex, 'hex').toString('utf8');
            // Filter out non-printable characters
            return raw.replace(/[^\x20-\x7E]/g, '').trim();
        } catch (e) {
            return null;
        }
    }

    // Helper: Fetch Block Data
    async function fetchBlockData(blockHeight) {
        // 1. Get Block Hash
        const hashRes = await fetch(`https://mempool.space/api/block-height/${blockHeight}`);
        if (!hashRes.ok) throw new Error("Block not found");
        const blockHash = await hashRes.text();

        // 2. Get Block TXs (first 25 is usually enough for coinbase, but we might need more for op_returns)
        // Note: Mempool API pagination might be needed for full block scan, but let's start with the main endpoint
        const txsRes = await fetch(`https://mempool.space/api/block/${blockHash}/txs`);
        if (!txsRes.ok) throw new Error("Failed to fetch block transactions");
        return await txsRes.json();
    }

    // Endpoint: Scan Block for Messages
    router.get('/scan-block/:height', async (req, res) => {
        const { height } = req.params;
        try {
            const txs = await fetchBlockData(height);
            const messages = [];

            // 1. Coinbase (First TX)
            if (txs.length > 0 && txs[0].vin && txs[0].vin[0].is_coinbase) {
                const hex = txs[0].vin[0].scriptsig;
                const msg = decodeHex(hex);
                if (msg) {
                    messages.push({
                        type: 'COINBASE',
                        message: msg,
                        txId: txs[0].txid,
                        description: `Coinbase Message from Block ${height}`
                    });
                }
            }

            // 2. Scan other TXs for OP_RETURN
            // Limit to first 50 TXs to avoid timeout/spam
            for (const tx of txs.slice(1, 50)) {
                const opReturn = tx.vout.find(out => out.scriptpubkey_type === 'op_return');
                if (opReturn) {
                    const asmParts = opReturn.scriptpubkey_asm.split(' ');
                    const hex = asmParts[asmParts.length - 1];
                    const msg = decodeHex(hex);
                    if (msg && msg.length > 3) { // Filter very short noise
                        messages.push({
                            type: 'OP_RETURN',
                            message: msg,
                            txId: tx.txid,
                            description: `OP_RETURN from Block ${height}`
                        });
                    }
                }
            }

            res.json(messages);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: error.message });
        }
    });

    // Admin: Add entry
    router.post('/', async (req, res) => {
        const { message, description, txId } = req.body;
        
        let finalMessage = message;
        let txDate = Math.floor(Date.now() / 1000); // Default to now
        let blockHeight = 0;
        let amount = 0;

        try {
            // 1. Auto-fetch logic: If we have a TXID, fetch it to get date and/or message
            if (txId) {
                console.log(`[HallOfFame] Fetching TX details for: ${txId}`);
                
                const response = await fetch(`https://mempool.space/api/tx/${txId}`);
                
                if (!response.ok) {
                    throw new Error(`Mempool API error: ${response.statusText}`);
                }

                const txData = await response.json();

                // Get Date & Height
                if (txData.status) {
                    if (txData.status.block_time) txDate = txData.status.block_time;
                    if (txData.status.block_height) blockHeight = txData.status.block_height;
                }

                // Calculate Total Output Amount (Sats)
                if (txData.vout) {
                    amount = txData.vout.reduce((acc, out) => acc + (out.value || 0), 0);
                }

                // If message not provided, try to find it
                if (!finalMessage) {
                    // Check for Coinbase Message (Input)
                    if (txData.vin && txData.vin.length > 0 && txData.vin[0].is_coinbase) {
                        const hexData = txData.vin[0].scriptsig;
                        if (hexData) {
                            finalMessage = decodeHex(hexData);
                            console.log(`[HallOfFame] Decoded Coinbase message: ${finalMessage}`);
                        }
                    }

                    // If not found, look for OP_RETURN output
                    if (!finalMessage) {
                        const opReturnOutput = txData.vout.find(out => out.scriptpubkey_type === 'op_return');
                        
                        if (opReturnOutput) {
                            const asmParts = opReturnOutput.scriptpubkey_asm.split(' ');
                            const hexData = asmParts[asmParts.length - 1];
                            
                            if (hexData) {
                                finalMessage = decodeHex(hexData);
                                console.log(`[HallOfFame] Decoded message: ${finalMessage}`);
                            }
                        }
                    }
                }
            }

            // 2. Validation
            if (!finalMessage) {
                return res.status(400).json({ error: "Message is required (or valid TXID)." });
            }

            await new Promise((resolve, reject) => {
                db.run(
                    "INSERT INTO hall_of_fame (message, description, txId, txDate, blockHeight, amount) VALUES (?, ?, ?, ?, ?, ?)",
                    [finalMessage, description, txId, txDate, blockHeight, amount],
                    function(err) {
                        if (err) return reject(err);
                        resolve(this.lastID);
                    }
                );
            });
            res.status(201).json({ success: true, message: finalMessage, txId, txDate, blockHeight, amount });
        } catch (error) {
            console.error("Error adding to Hall of Fame:", error);
            res.status(500).json({ error: "Failed to add entry: " + error.message });
        }
    });

    // Admin: Delete entry
    router.delete('/:id', async (req, res) => {
        const { id } = req.params;
        try {
            await new Promise((resolve, reject) => {
                db.run("DELETE FROM hall_of_fame WHERE id = ?", [id], function(err) {
                    if (err) return reject(err);
                    resolve();
                });
            });
            res.status(200).json({ success: true });
        } catch (error) {
            console.error("Error deleting from Hall of Fame:", error);
            res.status(500).json({ error: "Failed to delete entry" });
        }
    });

    return router;
}

module.exports = createHallOfFameRouter;
