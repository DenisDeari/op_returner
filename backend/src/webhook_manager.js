const axios = require('axios');

async function registerWebhook(btcAddress, config) {
    if (!config.BLOCKCYPHER_TOKEN) {
        console.warn("BLOCKCYPHER_TOKEN not found. Skipping webhook registration.");
        return null;
    }
    const webhookUrl = `${config.WEBHOOK_RECEIVER_BASE_URL}/api/webhook/payment-notification`;
    const apiUrl = `${config.BLOCKCYPHER_API_BASE}/hooks?token=${config.BLOCKCYPHER_TOKEN}`;
    
    const events = ["unconfirmed-tx", "confirmed-tx"];
    const hookIds = [];

    console.log(`Registering webhooks for ${btcAddress}...`);

    for (const eventType of events) {
        const payload = { event: eventType, address: btcAddress, url: webhookUrl };
        try {
            const response = await axios.post(apiUrl, payload);
            console.log(`Successfully registered ${eventType} webhook. ID: ${response.data.id}`);
            hookIds.push(response.data.id);
        } catch (error) {
            console.error(`Error registering ${eventType} webhook:`, error.message);
            if (error.response) {
                // console.error('API Error Status:', error.response.status, 'Data:', error.response.data);
                if (error.response.status === 429) {
                    console.warn("Rate limit exceeded during webhook registration.");
                }
            }
        }
    }
    return hookIds.length > 0 ? hookIds.join(',') : null;
}

async function deleteWebhook(hookIdString, config) {
    if (!hookIdString || !config.BLOCKCYPHER_TOKEN) return;

    const hookIds = hookIdString.split(',');
    const apiUrlBase = `${config.BLOCKCYPHER_API_BASE}/hooks`;

    for (const hookId of hookIds) {
        const apiUrl = `${apiUrlBase}/${hookId}?token=${config.BLOCKCYPHER_TOKEN}`;
        try {
            await axios.delete(apiUrl);
            console.log(`Successfully deleted webhook ID: ${hookId}`);
        } catch (error) {
            console.error(`Error deleting webhook ${hookId}:`, error.message);
            if (error.response && error.response.status === 404) {
                console.log("Webhook already deleted or not found.");
            }
        }
    }
}

module.exports = { registerWebhook, deleteWebhook };
