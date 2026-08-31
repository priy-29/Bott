const { runMonitoring } = require('../src/monitor');

export default async function handler(req, res) {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const results = await runMonitoring();
        res.status(200).json({ status: 'Monitoring OK', results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
