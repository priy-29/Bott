const { Telegraf, Markup } = require('telegraf');
const { authMiddleware, encrypt } = require('./security');
const { MainDB, TargetDB } = require('./database');
const { runMonitoring } = require('./monitor');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

function esc(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function short(v, n = 2800) { let s; try { s = JSON.stringify(v, null, 2); } catch { s = String(v); } return s.length > n ? `${s.slice(0, n)}…` : s; }
function normalizeCollections(text) { return [...new Set(String(text).split(',').map(v => v.trim().replace(/^\/|\/$/g, '')).filter(v => /^[A-Za-z0-9_./-]+$/.test(v)))]; }
function enc(v) { return Buffer.from(String(v), 'utf8').toString('base64url'); }
function dec(v) { return Buffer.from(String(v), 'base64url').toString('utf8'); }
function home() { return Markup.inlineKeyboard([[Markup.button.callback('📊 Dashboard', 'menu_dashboard'), Markup.button.callback('🗄️ Firebase Targets', 'menu_targets')], [Markup.button.callback('👁️ Monitoring', 'menu_monitoring'), Markup.button.callback('⚙️ Settings', 'menu_settings')], [Markup.button.callback('📜 Event History', 'menu_events')]]); }
function back() { return Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu Utama', 'menu_main')]]); }
function targetMenu(id) { return Markup.inlineKeyboard([[Markup.button.callback('👁️ Toggle Monitor', `toggle_${id}`), Markup.button.callback('📁 Collections', `coll_${id}`)], [Markup.button.callback('🔎 Inspect Data', `inspect_${id}`), Markup.button.callback('📊 Stats', `stats_${id}`)], [Markup.button.callback('🧪 Test Connection', `test_${id}`)], [Markup.button.callback('🗑️ Hapus Target', `remove_${id}`), Markup.button.callback('⬅️ Kembali', 'menu_targets')]]); }

bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) {
        try { await ctx.answerCbQuery(); } catch (error) {
            const msg = String(error?.message || '');
            if (!msg.includes('query is too old') && !msg.includes('query ID is invalid')) console.error('Callback ACK:', msg);
        }
    }
    return next();
});
bot.use(authMiddleware);

bot.catch(async (error, ctx) => {
    const message = String(error?.message || error || '');
    console.error(`Bot error [${ctx.updateType}]:`, error);
    await MainDB.log('ERROR', `Bot error: ${ctx.updateType}`, { error: message.slice(0, 500) }).catch(() => {});
    if (ctx.callbackQuery) {
        try { await ctx.reply('❌ Permintaan gagal diproses. Silakan buka menu lagi.'); } catch {}
        return;
    }
    try { await ctx.reply('❌ Terjadi kesalahan pada server. Silakan coba lagi.'); } catch {}
});

async function edit(ctx, text, markup) {
    try { return await ctx.editMessageText(text, { parse_mode: 'HTML', ...markup }); }
    catch (e) {
        if (!String(e.message).includes('message is not modified')) return ctx.reply(text, { parse_mode: 'HTML', ...markup });
    }
}

async function showHome(ctx) { return edit(ctx, '🔥 <b>FIREBASE MONITOR PRO</b>\n\nKelola banyak Firebase dan pantau perubahan Firestore dari Telegram.', home()); }

bot.start(ctx => ctx.reply('🔥 <b>FIREBASE MONITOR PRO</b>\n\nSistem siap digunakan.', { parse_mode: 'HTML', ...home() }));
bot.command('menu', showHome);
bot.action('menu_main', showHome);

bot.action('menu_dashboard', async ctx => {
    const d = await MainDB.getDashboard();
    const stats = await MainDB.getAllStats();
    const text = `📊 <b>DASHBOARD</b>\n\n🎯 Targets: <b>${d.targets}</b>\n🟢 Active: <b>${d.activeTargets}</b>\n📁 Collections: <b>${d.collections}</b>\n📌 Events today: <b>${d.eventsToday}</b>\n\n🟢 Created: ${d.created}\n🟡 Updated: ${d.updated}\n🔴 Deleted: ${d.deleted}\n❌ Errors: ${d.errors}\n\n📡 Firebase instances: ${Object.keys(stats).length}`;
    return edit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'menu_dashboard')], [Markup.button.callback('⬅️ Menu Utama', 'menu_main')]]));
});

bot.action('menu_targets', async ctx => {
    const targets = await MainDB.getAllTargets();
    let text = '🗄️ <b>FIREBASE TARGETS</b>\n\n';
    const rows = [[Markup.button.callback('➕ Tambah Firebase Baru', 'action_add_target')]];
    if (!targets.length) text += 'Belum ada target.\n';
    for (const t of targets) {
        const icon = t.monitoring?.enabled ? '🟢' : '🔴';
        text += `${icon} <b>${esc(t.name)}</b>\n<code>${esc(t.projectId)}</code>\n📁 ${t.monitoring?.collections?.length || 0} collection\n\n`;
        rows.push([Markup.button.callback(`${icon} ${String(t.name).slice(0, 30)}`, `detail_${t.id}`)]);
    }
    rows.push([Markup.button.callback('🔄 Refresh', 'menu_targets'), Markup.button.callback('⬅️ Menu Utama', 'menu_main')]);
    return edit(ctx, text, { reply_markup: { inline_keyboard: rows } });
});

bot.action('action_add_target', async ctx => {
    await MainDB.setState(ctx.from.id, { step: 'AWAITING_NAME' });
    return ctx.reply('📝 <b>Nama Firebase target</b>\n\nContoh: Production App', { parse_mode: 'HTML' });
});

bot.action(/detail_(.+)/, async ctx => {
    const target = await MainDB.getTarget(ctx.match[1]);
    if (!target) return edit(ctx, '❌ Target tidak ditemukan.', back());
    const collections = target.monitoring?.collections || [];
    return edit(ctx, `🗄️ <b>${esc(target.name)}</b>\n\n📦 Project: <code>${esc(target.projectId)}</code>\n👁️ Monitoring: ${target.monitoring?.enabled ? '🟢 ON' : '🔴 OFF'}\n📁 Collections: ${collections.length ? `<code>${esc(collections.join(', '))}</code>` : 'Belum diatur'}`, targetMenu(target.id));
});

bot.action(/toggle_(.+)/, async ctx => {
    const target = await MainDB.getTarget(ctx.match[1]);
    if (!target) return edit(ctx, '❌ Target tidak ditemukan.', back());
    const enabled = !target.monitoring?.enabled;
    await MainDB.updateTargetMonitoring(target.id, enabled, target.monitoring?.collections || []);
    return edit(ctx, `👁️ Monitoring sekarang <b>${enabled ? '🟢 ON' : '🔴 OFF'}</b>`, targetMenu(target.id));
});

bot.action(/coll_(.+)/, async ctx => {
    const target = await MainDB.getTarget(ctx.match[1]);
    if (!target) return edit(ctx, '❌ Target tidak ditemukan.', back());
    await MainDB.setState(ctx.from.id, { step: 'AWAITING_COLLECTION', targetId: target.id });
    return ctx.reply(`📁 <b>Collection untuk ${esc(target.name)}</b>\n\nPisahkan dengan koma.\nContoh: <code>users, orders, settings</code>`, { parse_mode: 'HTML' });
});

bot.action(/inspect_(.+)/, async ctx => {
    const target = await MainDB.getTarget(ctx.match[1]);
    if (!target) return edit(ctx, '❌ Target tidak ditemukan.', back());
    try {
        const cols = await TargetDB.listCollections(target.id);
        const rows = cols.slice(0, 40).map(c => [Markup.button.callback(`📁 ${c.slice(0, 45)}`, `ilist.${enc(target.id)}.${enc(c)}`)]);
        rows.push([Markup.button.callback('🔍 Search Document', `searchdoc_${enc(target.id)}`)], [Markup.button.callback('⬅️ Kembali', `detail_${target.id}`)]);
        return edit(ctx, `🔎 <b>INSPECT DATA</b>\n\nTarget: <b>${esc(target.name)}</b>\n\nPilih collection:`, { reply_markup: { inline_keyboard: rows } });
    } catch (error) {
        console.error('Inspect error:', error);
        return edit(ctx, `❌ <b>Gagal mengambil collection</b>\n\n${esc(error?.message || 'Firebase error')}`, back());
    }
});

bot.action(/^ilist\.(.+)$/, async ctx => {
    const parts = String(ctx.match[1]).split('.');
    if (parts.length < 2) return ctx.reply('❌ Data tombol tidak valid. Buka Inspect Data lagi.');
    const targetId = dec(parts.shift());
    const collection = dec(parts.join('.'));
    try {
        const target = await MainDB.getTarget(targetId);
        if (!target) return edit(ctx, '❌ Target tidak ditemukan.', back());
        const result = await TargetDB.listDocuments(targetId, collection, 10);
        const rows = result.docs.map(d => [Markup.button.callback(`📄 ${String(d.id).slice(0, 45)}`, `view.${enc(targetId)}.${enc(collection)}.${enc(d.id)}`)]);
        if (result.hasMore && result.nextCursor) rows.push([Markup.button.callback('➡️ Berikutnya', `ilistpage.${enc(targetId)}.${enc(collection)}.${enc(result.nextCursor)}`)]);
        rows.push([Markup.button.callback('🔍 Search Field', `searchfield.${enc(targetId)}.${enc(collection)}`)], [Markup.button.callback('⬅️ Collections', `inspect_${targetId}`)]);
        const text = `📁 <b>${esc(collection)}</b>\n\n${result.docs.length ? result.docs.map((d, i) => `${i + 1}. <code>${esc(d.id)}</code>`).join('\n') : 'Collection kosong.'}`;
        return edit(ctx, text, { reply_markup: { inline_keyboard: rows } });
    } catch (error) {
        console.error('List documents error:', error);
        return edit(ctx, `❌ <b>Gagal membaca collection</b>\n\n${esc(error?.message || 'Firebase error')}`, { reply_markup: { inline_keyboard: [[Markup.button.callback('🔄 Coba Lagi', `ilist.${enc(targetId)}.${enc(collection)}`)], [Markup.button.callback('⬅️ Collections', `inspect_${targetId}`)]] } });
    }
});

bot.action(/^ilistpage\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/, async ctx => {
    const targetId = dec(ctx.match[1]);
    const collection = dec(ctx.match[2]);
    const cursor = dec(ctx.match[3]);
    try {
        const result = await TargetDB.listDocuments(targetId, collection, 10, cursor);
        const rows = result.docs.map(d => [Markup.button.callback(`📄 ${String(d.id).slice(0, 45)}`, `view.${enc(targetId)}.${enc(collection)}.${enc(d.id)}`)]);
        if (result.hasMore && result.nextCursor) rows.push([Markup.button.callback('➡️ Berikutnya', `ilistpage.${enc(targetId)}.${enc(collection)}.${enc(result.nextCursor)}`)]);
        rows.push([Markup.button.callback('⬅️ Collections', `inspect_${targetId}`)]);
        const text = `📁 <b>${esc(collection)}</b>\n\n${result.docs.length ? result.docs.map((d, i) => `${i + 1}. <code>${esc(d.id)}</code>`).join('\n') : 'Tidak ada document lagi.'}`;
        return edit(ctx, text, { reply_markup: { inline_keyboard: rows } });
    } catch (error) {
        console.error('Document pagination error:', error);
        return edit(ctx, `❌ <b>Gagal membaca collection</b>\n\n${esc(error?.message || 'Firebase error')}`, { reply_markup: { inline_keyboard: [[Markup.button.callback('⬅️ Collections', `inspect_${targetId}`)]] } });
    }
});

bot.action(/^view\.(.+)$/, async ctx => {
    const parts = String(ctx.match[1]).split('.');
    if (parts.length < 3) return ctx.reply('❌ Data document tidak valid.');
    const targetId = dec(parts.shift());
    const collection = dec(parts.shift());
    const documentId = dec(parts.join('.'));
    try {
        const doc = await TargetDB.getDocument(targetId, collection, documentId);
        if (!doc) return edit(ctx, '❌ Document tidak ditemukan.', { reply_markup: { inline_keyboard: [[Markup.button.callback('⬅️ Kembali', `ilist.${enc(targetId)}.${enc(collection)}`)]] } });
        return edit(ctx, `📄 <b>${esc(collection)} / ${esc(doc.id)}</b>\n\n<pre>${esc(short(doc.data))}</pre>`, { reply_markup: { inline_keyboard: [[Markup.button.callback('⬅️ Kembali', `ilist.${enc(targetId)}.${enc(collection)}`)]] } });
    } catch (error) {
        console.error('View document error:', error);
        return edit(ctx, `❌ <b>Gagal membaca document</b>\n\n${esc(error?.message || 'Firebase error')}`, { reply_markup: { inline_keyboard: [[Markup.button.callback('⬅️ Kembali', `ilist.${enc(targetId)}.${enc(collection)}`)]] } });
    }
});

bot.action(/searchdoc_(.+)/, async ctx => {
    const targetId = dec(ctx.match[1]);
    await MainDB.setState(ctx.from.id, { step: 'AWAITING_DOCUMENT_ID', targetId });
    return ctx.reply('🔍 Kirim dalam format:\n<code>collection/documentId</code>', { parse_mode: 'HTML' });
});

bot.action(/^searchfield\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/, async ctx => {
    await MainDB.setState(ctx.from.id, { step: 'AWAITING_FIELD_SEARCH', targetId: dec(ctx.match[1]), collection: dec(ctx.match[2]) });
    return ctx.reply('🔍 Kirim dalam format:\n<code>field=value</code>\n\nContoh: <code>email=test@gmail.com</code>', { parse_mode: 'HTML' });
});

bot.action(/stats_(.+)/, async ctx => {
    const target = await MainDB.getTarget(ctx.match[1]);
    if (!target) return edit(ctx, '❌ Target tidak ditemukan.', back());
    const s = await MainDB.getStats(target.id);
    return edit(ctx, `📊 <b>STATS — ${esc(target.name)}</b>\n\n🟢 Created: ${s.create || 0}\n🟡 Updated: ${s.update || 0}\n🔴 Deleted: ${s.delete || 0}\n❌ Errors: ${s.errors || 0}\n\n🕒 Last update: ${s.updatedAt ? new Date(s.updatedAt).toLocaleString('id-ID') : '-'}`, { reply_markup: { inline_keyboard: [[Markup.button.callback('🔄 Refresh', `stats_${target.id}`)], [Markup.button.callback('⬅️ Kembali', `detail_${target.id}`)]] } });
});

bot.action(/test_(.+)/, async ctx => {
    const target = await MainDB.getTarget(ctx.match[1]);
    if (!target) return edit(ctx, '❌ Target tidak ditemukan.', back());
    const started = Date.now();
    try {
        await TargetDB.listCollections(target.id);
        return edit(ctx, `🟢 <b>CONNECTION OK</b>\n\nProject: <code>${esc(target.projectId)}</code>\nLatency: <b>${Date.now() - started} ms</b>`, targetMenu(target.id));
    } catch (error) {
        return edit(ctx, `🔴 <b>CONNECTION FAILED</b>\n\n${esc(String(error.message || 'Koneksi gagal'))}`, targetMenu(target.id));
    }
});

bot.action(/remove_(.+)/, async ctx => edit(ctx, '⚠️ <b>KONFIRMASI PENGHAPUSAN</b>\n\nSemua konfigurasi dan snapshot target akan dihapus.', { reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Batal', `detail_${ctx.match[1]}`), Markup.button.callback('✅ Hapus Permanen', `confirm_remove_${ctx.match[1]}`)]] } }));
bot.action(/confirm_remove_(.+)/, async ctx => { await MainDB.deleteTarget(ctx.match[1]); return edit(ctx, '✅ Target berhasil dihapus.', { ...home() }); });

bot.action('menu_monitoring', async ctx => {
    const targets = await MainDB.getAllTargets();
    const rows = targets.map(t => [Markup.button.callback(`${t.monitoring?.enabled ? '🟢' : '🔴'} ${String(t.name).slice(0, 35)}`, `detail_${t.id}`)]);
    rows.push([Markup.button.callback('🔄 Scan Semua Sekarang', 'scan_all')], [Markup.button.callback('⬅️ Menu Utama', 'menu_main')]);
    return edit(ctx, `👁️ <b>MONITORING</b>\n\n🟢 Aktif: ${targets.filter(t => t.monitoring?.enabled).length}/${targets.length}\n\nPilih target atau jalankan scan manual.`, { reply_markup: { inline_keyboard: rows } });
});
bot.action('scan_all', async ctx => { const result = await runMonitoring({ force: true }); const total = result.results.reduce((n, r) => n + Number(r.changes || 0), 0); return edit(ctx, `🔄 <b>SCAN SELESAI</b>\n\nTarget diproses: ${result.results.length}\nPerubahan: ${total}\nDurasi: ${result.duration} ms`, { reply_markup: { inline_keyboard: [[Markup.button.callback('🔄 Scan Lagi', 'scan_all')], [Markup.button.callback('⬅️ Monitoring', 'menu_monitoring')]] } }); });

bot.action('menu_events', async ctx => {
    const events = await MainDB.getEvents({ limit: 15 });
    const text = `📜 <b>EVENT HISTORY</b>\n\n${events.length ? events.map(e => `${e.action === 'CREATE' ? '🟢' : e.action === 'UPDATE' ? '🟡' : '🔴'} <b>${esc(e.collection)}</b> / <code>${esc(e.document)}</code>\n${new Date(e.createdAt).toLocaleString('id-ID')}`).join('\n\n') : 'Belum ada event.'}`;
    return edit(ctx, text, { reply_markup: { inline_keyboard: [[Markup.button.callback('🔄 Refresh', 'menu_events')], [Markup.button.callback('⬅️ Menu Utama', 'menu_main')]] } });
});

bot.action('menu_settings', async ctx => {
    const s = await MainDB.getSystemSettings();
    return edit(ctx, `⚙️ <b>SETTINGS</b>\n\n⏱ Interval default: ${Math.round(Number(s.intervalMs || 300000) / 60000)} menit\n📦 Max docs/scan: ${s.maxDocs || 1000}\n🔔 Notifications: ${s.notifications === false ? '🔴 OFF' : '🟢 ON'}\n📦 Batch size: ${s.batchSize || 200}`, { reply_markup: { inline_keyboard: [[Markup.button.callback('🔔 Toggle Notifications', 'settings_notify')], [Markup.button.callback('⚡ Scan Sekarang', 'scan_all')], [Markup.button.callback('⬅️ Menu Utama', 'menu_main')]] } });
});
bot.action('settings_notify', async ctx => { const s = await MainDB.getSystemSettings(); await MainDB.setSystemSettings({ notifications: s.notifications === false }); return bot.telegram.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, '⚙️ Settings diperbarui.', { parse_mode: 'HTML', ...back() }); });

bot.on('text', async ctx => {
    const state = await MainDB.getState(ctx.from.id);
    if (!state) return;
    const input = ctx.message.text.trim();
    try {
        if (state.step === 'AWAITING_NAME') {
            if (!input || input.length > 80) return ctx.reply('❌ Nama tidak valid. Maksimal 80 karakter.');
            await MainDB.setState(ctx.from.id, { step: 'AWAITING_JSON', targetName: input });
            return ctx.reply('🔑 Paste JSON Service Account Firebase. Pesan credential akan dihapus setelah diproses.');
        }
        if (state.step === 'AWAITING_JSON') {
            let creds;
            try { creds = JSON.parse(input); } catch { return ctx.reply('❌ JSON tidak valid. Kirim ulang JSON Service Account.'); }
            const test = await TargetDB.testConnection(creds);
            if (!test.success) return ctx.reply(`❌ Koneksi gagal: ${esc(test.error)}`, { parse_mode: 'HTML' });
            const target = { id: `db_${Date.now()}`, name: state.targetName, projectId: test.projectId, credentialEncrypted: encrypt(input), monitoring: { enabled: false, collections: [] } };
            await MainDB.addTarget(target);
            await MainDB.clearState(ctx.from.id);
            try { await ctx.deleteMessage(ctx.message.message_id); } catch {}
            return ctx.reply(`✅ <b>Target berhasil ditambahkan</b>\n\nNama: ${esc(target.name)}\nProject: <code>${esc(target.projectId)}</code>\nLatency test: ${test.latency} ms`, { parse_mode: 'HTML', ...home() });
        }
        if (state.step === 'AWAITING_COLLECTION') {
            const collections = normalizeCollections(input);
            if (!collections.length) return ctx.reply('❌ Collection tidak valid. Contoh: users, orders');
            const target = await MainDB.getTarget(state.targetId);
            if (!target) return ctx.reply('❌ Target tidak ditemukan.');
            await MainDB.updateTargetMonitoring(target.id, target.monitoring?.enabled || false, collections);
            await MainDB.clearState(ctx.from.id);
            return ctx.reply(`✅ Collection tersimpan:\n<code>${esc(collections.join(', '))}</code>`, { parse_mode: 'HTML' });
        }
        if (state.step === 'AWAITING_DOCUMENT_ID') {
            const [collection, ...idParts] = input.split('/');
            const documentId = idParts.join('/');
            if (!collection || !documentId) return ctx.reply('❌ Format salah. Gunakan collection/documentId');
            const doc = await TargetDB.getDocument(state.targetId, collection, documentId);
            await MainDB.clearState(ctx.from.id);
            return ctx.reply(doc ? `📄 <b>${esc(collection)}/${esc(doc.id)}</b>\n\n<pre>${esc(short(doc.data))}</pre>` : '❌ Document tidak ditemukan.', { parse_mode: 'HTML' });
        }
        if (state.step === 'AWAITING_FIELD_SEARCH') {
            const index = input.indexOf('=');
            if (index < 1) return ctx.reply('❌ Format salah. Gunakan field=value');
            const field = input.slice(0, index).trim(); const value = input.slice(index + 1).trim();
            const results = await TargetDB.searchDocuments(state.targetId, state.collection, field, value, 20);
            await MainDB.clearState(ctx.from.id);
            return ctx.reply(`🔎 <b>HASIL SEARCH</b>\n\n${results.length ? results.map(d => `• <code>${esc(d.id)}</code>`).join('\n') : 'Tidak ditemukan.'}`, { parse_mode: 'HTML' });
        }
    } catch (error) {
        await MainDB.clearState(ctx.from.id).catch(() => {});
        await MainDB.log('ERROR', 'Text handler failed', { error: error.message }).catch(() => {});
        return ctx.reply('❌ Permintaan gagal diproses. Coba lagi.');
    }
});

module.exports = bot;
