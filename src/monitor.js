const { MainDB, TargetDB } = require('./database');
const { Telegram } = require('telegraf');
const { ADMIN_IDS } = require('./security');

const telegram = new Telegram(process.env.TELEGRAM_BOT_TOKEN);
let running = false;

function stable(value) {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

function detectChanges(oldData, newData) {
    const changes = [];
    for (const [id, doc] of Object.entries(newData)) {
        if (!Object.prototype.hasOwnProperty.call(oldData, id)) {
            changes.push({ action: 'CREATE', document: id, new: doc });
            continue;
        }
        if (stable(oldData[id]) !== stable(doc)) {
            const keys = new Set([...Object.keys(oldData[id] || {}), ...Object.keys(doc || {})]);
            const changed = [...keys].filter(key => stable(oldData[id]?.[key]) !== stable(doc?.[key]));
            changes.push({ action: 'UPDATE', document: id, changed, old: oldData[id], new: doc });
        }
    }
    for (const id of Object.keys(oldData)) {
        if (!Object.prototype.hasOwnProperty.call(newData, id)) changes.push({ action: 'DELETE', document: id, old: oldData[id] });
    }
    return changes;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function compact(value, max = 2200) {
    let text;
    try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
    if (text.length > max) return `${text.slice(0, max)}…`;
    return text;
}

async function sendAlert(target, collection, change) {
    const icon = change.action === 'CREATE' ? '🟢' : change.action === 'UPDATE' ? '🟡' : '🔴';
    let msg = `${icon} <b>FIREBASE CHANGE</b>\n\n🗄️ <b>${escapeHtml(target.name)}</b>\n📦 <code>${escapeHtml(target.projectId)}</code>\n📁 <code>${escapeHtml(collection)}</code>\n📄 <code>${escapeHtml(change.document)}</code>\n⚡ <b>${change.action}</b>`;
    if (change.action === 'UPDATE') msg += `\n🔄 Changed: <code>${escapeHtml((change.changed || []).join(', '))}</code>\n\n<pre>${escapeHtml(compact({ old: change.old, new: change.new }))}</pre>`;
    if (change.action === 'CREATE') msg += `\n\n<pre>${escapeHtml(compact(change.new))}</pre>`;
    if (change.action === 'DELETE') msg += `\n\n<pre>${escapeHtml(compact(change.old))}</pre>`;
    if (msg.length > 3900) msg = `${msg.slice(0, 3880)}…`;
    for (const adminId of ADMIN_IDS) {
        try { await telegram.sendMessage(adminId, msg, { parse_mode: 'HTML' }); } catch (error) { await MainDB.log('ERROR', 'Telegram notification failed', { adminId, error: error.message }).catch(() => {}); }
    }
}

async function scanCollection(target, collection, options = {}) {
    const limit = Math.min(Math.max(Number(options.maxDocs || 1000), 1), 5000);
    const db = await TargetDB.getTargetFirestore(target.id);
    const snap = await db.collection(collection).limit(limit).get();
    const current = {};
    snap.forEach(doc => { current[doc.id] = doc.data(); });
    const old = await MainDB.getSnapshot(target.id, collection);
    const initial = Object.keys(old).length === 0;
    const changes = initial ? [] : detectChanges(old, current);
    if (!initial) {
        for (const change of changes) {
            await MainDB.addEvent({ targetId: target.id, targetName: target.name, collection, action: change.action, document: change.document, changed: change.changed || [] });
            await MainDB.incrementStat(target.id, change.action.toLowerCase());
        }
    }
    await MainDB.saveSnapshot(target.id, collection, current, { scanned: snap.size, limited: snap.size >= limit });
    return { collection, scanned: snap.size, limited: snap.size >= limit, changes, initial };
}

async function runMonitoring(options = {}) {
    if (running && !options.force) return { locked: true, results: [] };
    running = true;
    const started = Date.now();
    const results = [];
    try {
        const targets = await MainDB.getAllTargets();
        for (const target of targets.filter(t => t.monitoring?.enabled || options.targetId === t.id)) {
            const collections = target.monitoring?.collections || [];
            const targetResult = { target: target.name, targetId: target.id, status: 'success', collections: [], changes: 0 };
            try {
                if (!collections.length) {
                    targetResult.status = 'no-collections';
                } else {
                    const settings = await MainDB.getSystemSettings();
                    for (const collection of collections) {
                        const result = await scanCollection(target, collection, { maxDocs: settings.maxDocs });
                        targetResult.collections.push(result);
                        targetResult.changes += result.changes.length;
                        if (settings.notifications !== false) {
                            for (const change of result.changes.slice(0, 20)) await sendAlert(target, collection, change);
                            if (result.changes.length > 20) {
                                for (const adminId of ADMIN_IDS) await telegram.sendMessage(adminId, `📊 <b>${result.changes.length - 20} perubahan lainnya</b> diringkas dari ${escapeHtml(target.name)}/${escapeHtml(collection)}.`, { parse_mode: 'HTML' }).catch(() => {});
                            }
                        }
                    }
                }
            } catch (error) {
                targetResult.status = 'error';
                targetResult.error = String(error.message || 'Monitoring gagal').slice(0, 300);
                await MainDB.incrementStat(target.id, 'errors').catch(() => {});
                await MainDB.log('ERROR', 'Monitoring target failed', { targetId: target.id, error: targetResult.error }).catch(() => {});
            }
            results.push(targetResult);
        }
        return { locked: false, duration: Date.now() - started, results };
    } finally {
        running = false;
    }
}

module.exports = { runMonitoring, scanCollection, detectChanges };
                
