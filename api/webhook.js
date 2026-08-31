const bot = require('../src/bot');

export default async function handler(req, res) {
    if (req.method === 'POST') {
        try {
            await bot.handleUpdate(req.body, res);
            res.status(200).send('OK');
        } catch (error) {
            console.error('Webhook error:', error);
            res.status(500).send('Error processing webhook');
        }
    } else {
        const url = `https://${req.headers.host}/api/webhook`;
        await bot.telegram.setWebhook(url);
        res.status(200).send(`Webhook configured to ${url}`);
    }
}
