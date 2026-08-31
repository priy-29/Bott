const bot = require('../src/bot');
const { runMonitoring } = require('../src/monitor');

module.exports = async function handler(req, res) {
    if (req.method === 'GET') {
        if (req.headers['x-vercel-cron'] || req.query?.cron === '1') {
            const secret = req.headers['x-cron-secret'] || req.query?.secret;
            if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
            try {
                const result = await runMonitoring();
                return res.status(200).json({ ok: true, ...result });
            } catch (error) {
                console.error('Cron error:', error);
                return res.status(500).json({ ok: false });
            }
        }
        return res.status(200).send('Firebase Monitor Bot is running.');
    }
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    try {
        await bot.handleUpdate(req.body);
        return res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook error:', error);
        return res.status(500).send('Error');
    }
};
