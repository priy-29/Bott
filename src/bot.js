const { Telegraf, Markup } = require('telegraf');
const { authMiddleware, encrypt } = require('./security');
const { MainDB, TargetDB } = require('./database');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(authMiddleware);

// Global Error Handler
bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}:`, err);
    ctx.reply(`❌ Terjadi kesalahan: ${err.message}`);
});

const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Dashboard', 'menu_dashboard'), Markup.button.callback('🗄️ Firebase Targets', 'menu_targets')],
    [Markup.button.callback('👁️ Monitoring', 'menu_monitoring'), Markup.button.callback('⚙️ Settings', 'menu_settings')]
]);

const targetDetailMenu = (id) => Markup.inlineKeyboard([
    [Markup.button.callback('👁️ Toggle Monitor', `toggle_${id}`), Markup.button.callback('📁 Set Collections', `coll_${id}`)],
    [Markup.button.callback('🔎 Inspect Data', `inspect_${id}`), Markup.button.callback('📊 Stats', `stats_${id}`)],
    [Markup.button.callback('🗑️ Hapus Target', `remove_${id}`), Markup.button.callback('⬅️ Kembali', 'menu_targets')]
]);

bot.start((ctx) => {
    ctx.reply('🔥 <b>FIREBASE MONITOR PRO</b>\n\nSistem berhasil dihidupkan.', { parse_mode: 'HTML', ...mainMenu });
});

bot.action('menu_main', (ctx) => {
    ctx.answerCbQuery();
    ctx.editMessageText('🔥 <b>FIREBASE MONITOR PRO</b>', { parse_mode: 'HTML', ...mainMenu });
});

bot.action(['menu_dashboard', 'menu_monitoring', 'menu_settings'], (ctx) => {
    ctx.answerCbQuery('Fitur ini akan tersedia pada pembaruan berikutnya!', { show_alert: true });
});

bot.action('menu_targets', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const targets = await MainDB.getAllTargets();
        let text = '🗄️ <b>FIREBASE TARGETS</b>\n\n';
        const kb = [[Markup.button.callback('➕ Tambah Firebase Baru', 'action_add_target')]];
        
        if (targets.length === 0) {
            text += 'Belum ada target yang terdaftar.';
        } else {
            targets.forEach(t => {
                const icon = t.monitoring?.enabled ? '🟢' : '🔴';
                text += `${icon} <b>${t.name}</b>\n<code>${t.projectId}</code>\n\n`;
                kb.push([Markup.button.callback(`${icon} ${t.name}`, `detail_${t.id}`)]);
            });
        }
        kb.push([Markup.button.callback('🔄 Refresh', 'menu_targets'), Markup.button.callback('⬅️ Menu Utama', 'menu_main')]);
        ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    } catch (error) {
        ctx.answerCbQuery('Gagal membaca database utama.');
        ctx.reply(`❌ <b>DB ERROR:</b>\n<code>${error.message}</code>`, { parse_mode: 'HTML' });
    }
});

bot.action('action_add_target', async (ctx) => {
    await ctx.answerCbQuery();
    await MainDB.setState(ctx.from.id, { step: 'AWAITING_NAME' });
    ctx.reply('📝 <b>Masukkan NAMA untuk Firebase target ini:</b>\n\n(Contoh: Dirvi Gallery)', { parse_mode: 'HTML' });
});

bot.action(/detail_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const target = await MainDB.getTarget(ctx.match[1]);
    if (!target) return ctx.editMessageText('Target tidak ditemukan.', { ...mainMenu });
    
    const status = target.monitoring?.enabled ? '🟢 ON' : '🔴 OFF';
    const collections = target.monitoring?.collections?.length ? target.monitoring.collections.join(', ') : 'Belum diatur';
    
    ctx.editMessageText(`🗄️ <b>${target.name}</b>\n\n📦 Project ID: <code>${target.projectId}</code>\n👁️ Monitoring: ${status}\n📁 Collections: <code>${collections}</code>`, 
    { parse_mode: 'HTML', ...targetDetailMenu(target.id) });
});

bot.action(/toggle_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const target = await MainDB.getTarget(ctx.match[1]);
    if (!target) return;
    
    const newState = !target.monitoring?.enabled;
    const collections = target.monitoring?.collections || [];
    await MainDB.updateTargetMonitoring(target.id, newState, collections);
    
    bot.handleUpdate({ update_id: ctx.update.update_id, callback_query: { ...ctx.update.callback_query, data: `detail_${target.id}` } });
});

bot.action(/coll_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    await MainDB.setState(ctx.from.id, { step: 'AWAITING_COLLECTION', targetId: ctx.match[1] });
    ctx.reply('📝 <b>Ketik nama collection yang ingin dipantau.</b>\nJika lebih dari satu, pisahkan dengan koma.\n\nContoh: <code>users, orders, settings</code>', { parse_mode: 'HTML' });
});

bot.action(/inspect_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Fitur inspeksi data (query) segera hadir!');
});

bot.action(/stats_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Fitur statistik detail segera hadir!');
});

bot.action(/remove_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    ctx.editMessageText(`⚠️ <b>KONFIRMASI PENGHAPUSAN</b>\n\nAnda yakin ingin menghapus target ini beserta seluruh konfigurasi dan snapshot-nya?`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Batal', `detail_${id}`), Markup.button.callback('✅ Hapus Permanen', `confirm_remove_${id}`)]] }
    });
});

bot.action(/confirm_remove_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('✅ Target dihapus secara permanen.');
    await MainDB.deleteTarget(ctx.match[1]);
    bot.handleUpdate({ update_id: ctx.update.update_id, callback_query: { ...ctx.update.callback_query, data: 'menu_targets' } });
});

bot.on('text', async (ctx, next) => {
    const state = await MainDB.getState(ctx.from.id);
    if (!state) return next();

    if (state.step === 'AWAITING_NAME') {
        await MainDB.setState(ctx.from.id, { step: 'AWAITING_JSON', targetName: ctx.message.text });
        return ctx.reply(`Nama Tersimpan: <b>${ctx.message.text}</b>\n\n🔑 <b>Sekarang, paste isi JSON Service Account Firebase tersebut.</b>\n\nPastikan Anda menyalin semuanya dari kurung kurawal pembuka hingga penutup.`, { parse_mode: 'HTML' });
    }

    if (state.step === 'AWAITING_JSON') {
        try {
            const creds = JSON.parse(ctx.message.text);
            if (!creds.project_id || !creds.private_key) throw new Error('Format JSON Service Account tidak valid.');
            
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
                try { await ctx.deleteMessage(ctx.message.message_id); } catch(e){} 
                ctx.telegram.editMessageText(ctx.chat.id, testMsg.message_id, null, `✅ <b>TARGET BERHASIL DITAMBAHKAN</b>\n\nNama: <b>${targetData.name}</b>\nProject: <code>${targetData.projectId}</code>\n\nSilakan masuk ke menu Target untuk mengatur Collection.`, { parse_mode: 'HTML' });
            } else {
                await MainDB.clearState(ctx.from.id);
                ctx.reply(`❌ Koneksi gagal: ${result.error}`);
            }
        } catch (err) {
            await MainDB.clearState(ctx.from.id);
            ctx.reply(`❌ Validasi gagal: ${err.message}\nSilakan ulangi proses penambahan dari awal.`);
        }
    }

    if (state.step === 'AWAITING_COLLECTION') {
        const collections = ctx.message.text.split(',').map(s => s.trim()).filter(s => s);
        const target = await MainDB.getTarget(state.targetId);
        
        if (target) {
            await MainDB.updateTargetMonitoring(target.id, target.monitoring?.enabled || false, collections);
            ctx.reply(`✅ <b>Collection tersimpan:</b>\n<code>${collections.join(', ')}</code>`, { parse_mode: 'HTML' });
        }
        await MainDB.clearState(ctx.from.id);
    }
});

module.exports = bot;
