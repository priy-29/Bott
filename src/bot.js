const { Telegraf, Markup } = require('telegraf');
const { authMiddleware, encrypt } = require('./security');
const { MainDB, TargetDB } = require('./database');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(authMiddleware);

// --- MENUS ---
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Dashboard', 'menu_dashboard'), Markup.button.callback('🗄️ Firebase Targets', 'menu_targets')],
    [Markup.button.callback('👁️ Monitoring', 'menu_monitoring'), Markup.button.callback('⚙️ Settings', 'menu_settings')]
]);

const targetDetailMenu = (id) => Markup.inlineKeyboard([
    [Markup.button.callback('👁️ Monitoring Toggle', `toggle_${id}`), Markup.button.callback('📁 Collections', `coll_${id}`)],
    [Markup.button.callback('🔎 Inspect', `inspect_${id}`), Markup.button.callback('📊 Statistics', `stats_${id}`)],
    [Markup.button.callback('🗑️ Remove', `remove_${id}`), Markup.button.callback('⬅️ Back', 'menu_targets')]
]);

// --- COMMANDS & CALLBACKS ---
bot.start((ctx) => ctx.reply('🔥 <b>FIREBASE MONITOR PRO</b>\n\nDatabase Utama Bot menggunakan Firestore yang diisolasi.', { parse_mode: 'HTML', ...mainMenu }));
bot.action('menu_main', (ctx) => ctx.editMessageText('🔥 <b>FIREBASE MONITOR PRO</b>', { parse_mode: 'HTML', ...mainMenu }));

bot.action('menu_targets', async (ctx) => {
    const targets = await MainDB.getAllTargets();
    let text = '🗄️ <b>FIREBASE TARGETS</b>\n\n';
    const kb = [[Markup.button.callback('➕ Tambah Firebase', 'action_add_target')]];
    
    targets.forEach(t => {
        const icon = t.monitoring?.enabled ? '🟢' : '🔴';
        text += `${icon} <b>${t.name}</b>\n<code>${t.projectId}</code>\n\n`;
        kb.push([Markup.button.callback(`${icon} ${t.name}`, `detail_${t.id}`)]);
    });
    kb.push([Markup.button.callback('🔄 Refresh', 'menu_targets'), Markup.button.callback('⬅️ Menu Utama', 'menu_main')]);
    
    ctx.editMessageText(text || 'Belum ada Firebase target.', { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
});

bot.action('action_add_target', async (ctx) => {
    await MainDB.setState(ctx.from.id, { step: 'AWAITING_NAME' });
    ctx.reply('📝 Masukkan nama Firebase target (Contoh: Dirvi Gallery):');
});

bot.action(/detail_(.+)/, async (ctx) => {
    const target = await MainDB.getTarget(ctx.match[1]);
    if (!target) return ctx.answerCbQuery('Target tidak ditemukan.');
    const status = target.monitoring?.enabled ? '🟢 ON' : '🔴 OFF';
    ctx.editMessageText(`🗄️ <b>${target.name}</b>\n\nProject: <code>${target.projectId}</code>\nMonitoring: ${status}\nCollections: <code>${target.monitoring?.collections?.join(', ') || 'None'}</code>`, 
    { parse_mode: 'HTML', ...targetDetailMenu(target.id) });
});

bot.action(/remove_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    ctx.editMessageText(`⚠️ <b>HAPUS TARGET?</b>\nKonfigurasi dan snapshot akan dihapus permanen.`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Cancel', `detail_${id}`), Markup.button.callback('✅ Confirm Delete', `confirm_remove_${id}`)]] }
    });
});

bot.action(/confirm_remove_(.+)/, async (ctx) => {
    await MainDB.deleteTarget(ctx.match[1]);
    ctx.answerCbQuery('✅ Target dihapus.');
    bot.handleUpdate({ update_id: ctx.update.update_id, callback_query: { ...ctx.update.callback_query, data: 'menu_targets' } });
});

// --- TEXT STATE HANDLER (ADD FIREBASE FLOW) ---
bot.on('text', async (ctx, next) => {
    const state = await MainDB.getState(ctx.from.id);
    if (!state) return next();

    if (state.step === 'AWAITING_NAME') {
        await MainDB.setState(ctx.from.id, { step: 'AWAITING_JSON', targetName: ctx.message.text });
        return ctx.reply(`Nama: <b>${ctx.message.text}</b>\n\n🔑 Kirimkan JSON Service Account (text langsung):`, { parse_mode: 'HTML' });
    }

    if (state.step === 'AWAITING_JSON') {
        try {
            const creds = JSON.parse(ctx.message.text);
            if (!creds.project_id) throw new Error('Invalid JSON');
            
            const testMsg = await ctx.reply('⏳ Menguji koneksi target...');
            const result = await TargetDB.testConnection(creds);
            
            if (result.success) {
                const targetData = {
                    id: `db_${Date.now()}`,
                    name: state.targetName,
                    projectId: result.projectId,
                    credentialEncrypted: encrypt(ctx.message.text),
                    monitoring: { enabled: false, collections: [] }
                };
                await MainDB.addTarget(targetData);
                await MainDB.clearState(ctx.from.id);
                try { await ctx.deleteMessage(ctx.message.message_id); } catch(e){} // Hapus JSON dari chat
                ctx.telegram.editMessageText(ctx.chat.id, testMsg.message_id, null, `✅ <b>TARGET DITAMBAHKAN</b>\n\nNama: <b>${targetData.name}</b>\nProject: <code>${targetData.projectId}</code>`, { parse_mode: 'HTML' });
            } else {
                await MainDB.clearState(ctx.from.id);
                ctx.reply(`❌ Koneksi gagal: ${result.error}`);
            }
        } catch (err) {
            await MainDB.clearState(ctx.from.id);
            ctx.reply('❌ Format JSON tidak valid atau error. Silakan ulang /start');
        }
    }
});

module.exports = bot;
                                            
