const axios = require('axios');

// In Docker, these are already in process.env
const config = {
    BLOCKCYPHER_TOKEN: process.env.BLOCKCYPHER_TOKEN,
    BLOCKCYPHER_API_BASE: 'https://api.blockcypher.com/v1/btc/main'
};

async function purgeWebhooks() {
    if (!config.BLOCKCYPHER_TOKEN) {
        console.error("Error: BLOCKCYPHER_TOKEN is not set in the environment.");
        console.log("Usage: BLOCKCYPHER_TOKEN=your_token node purge_webhooks.js");
        process.exit(1);
    }

    console.log(`Using Token: ${config.BLOCKCYPHER_TOKEN.substring(0, 6)}...`);
    console.log("Fetching active webhooks...");

    try {
        const response = await axios.get(`${config.BLOCKCYPHER_API_BASE}/hooks?token=${config.BLOCKCYPHER_TOKEN}`);
        const hooks = response.data;

        if (!hooks || hooks.length === 0) {
            console.log("No active webhooks found.");
            return;
        }

        console.log(`Found ${hooks.length} webhooks. Deleting them now...`);

        for (const hook of hooks) {
            try {
                await axios.delete(`${config.BLOCKCYPHER_API_BASE}/hooks/${hook.id}?token=${config.BLOCKCYPHER_TOKEN}`);
                console.log(`Deleted webhook: ${hook.id} (${hook.event} -> ${hook.address})`);
                // Small delay to avoid hitting rate limits during deletion
                await new Promise(r => setTimeout(r, 250));
            } catch (err) {
                console.error(`Failed to delete ${hook.id}: ${err.message}`);
            }
        }
        console.log("Purge complete.");
    } catch (error) {
        console.error("Error fetching webhooks:", error.message);
        if (error.response && error.response.status === 429) {
            console.error("Rate limit hit. Please wait a moment and try again.");
        }
    }
}

purgeWebhooks();
