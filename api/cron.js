const { runMonitoring } = require('../src/monitor');

export default async function handler(req, res) {
    // Vercel Cron Authentication check
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}` && !req.headers['user-agent']?.includes('Vercel')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const results = await runMonitoring();
        res.status(200).json({ status: 'Monitoring cycle completed', results });
    } catch (error) {
        console.error('Cron Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
