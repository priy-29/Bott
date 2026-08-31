const { MainDB, TargetDB } = require('./database');
const { Telegram } = require('telegraf');
const { ADMIN_IDS } = require('./security');

const telegram = new Telegram(process.env.TELEGRAM_BOT_TOKEN);

function detectChanges(oldData, newData) {
    const changes = [];
    for (const [docId, newDoc] of Object.entries(newData)) {
        if (!oldData[docId]) {
            changes.push({ action: 'CREATE', document: docId, new: newDoc });
        } else {
            const oldDoc = oldData[docId];
            for (const key of Object.keys(newDoc)) {
                if (JSON.stringify(newDoc[key]) !== JSON.stringify(oldDoc[key])) {
                    changes.push({ action: 'UPDATE', document: docId, changed: key, old: oldDoc[key], new: newDoc[key] });
                }
            }
        }
    }
    for (const docId of Object.keys(oldData)) {
        if (!newData[docId]) changes.push({ action: 'DELETE', document: docId });
    }
    return changes;
}

async function sendAlert(target, collection, change) {
    let msg = `🚨 <b>FIREBASE CHANGE</b>\n\n🗄️ Database: <b>${target.name}</b>\n📦 Project: <code>${target.projectId}</code>\n📁 Collection: <code>${collection}</code>\n📄 Document: <code>${change.document}</code>\n\n⚡ Action: <b>${change.action}</b>\n`;
    if (change.action === 'UPDATE') {
        msg += `🔄 Changed: <code>${change.changed}</code>\n📉 Old: <code>${JSON.stringify(change.old)}</code>\n📈 New: <code>${JSON.stringify(change.new)}</code>`;
    }
    for (const adminId of ADMIN_IDS) {
        try { await telegram.sendMessage(adminId, msg, { parse_mode: 'HTML' }); } catch (e) {}
    }
}

async function runMonitoring() {
    const targets = await MainDB.getAllTargets();
    const activeTargets = targets.filter(t => t.monitoring?.enabled);
    const results = [];

    for (const target of activeTargets) {
        try {
            const targetDb = await TargetDB.getTargetFirestore(target.id);
            const collections = target.monitoring.collections || [];

            for (const col of collections) {
                const snapshot = await targetDb.collection(col).get();
                const currentData = {};
                snapshot.forEach(doc => currentData[doc.id] = doc.data());

                const oldData = await MainDB.getSnapshot(target.id, col);
                const changes = detectChanges(oldData, currentData);

                for (const change of changes) {
                    await sendAlert(target, col, change);
                    await MainDB.incrementStat(target.id, change.action.toLowerCase());
                }

                if (changes.length > 0 || Object.keys(oldData).length === 0) {
                    await MainDB.saveSnapshot(target.id, col, currentData);
                }
            }
            results.push({ target: target.name, status: 'success' });
        } catch (error) {
            await MainDB.incrementStat(target.id, 'errors');
            results.push({ target: target.name, status: 'error', error: error.message });
        }
    }
    return results;
}

module.exports = { runMonitoring };
