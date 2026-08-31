const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(v => v.trim()).filter(Boolean);

function keyBuffer() {
    if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is required.');
    const raw = Buffer.from(ENCRYPTION_KEY, 'utf8');
    if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must be exactly 32 bytes.');
    return raw;
}

function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer(), iv);
    const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(value) {
    if (!value) throw new Error('Encrypted value is empty.');
    const parts = String(value).split(':');
    if (parts.length === 2) {
        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = Buffer.from(parts[1], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer(), iv);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    }
    if (parts.length !== 3) throw new Error('Invalid encrypted value.');
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function isAuthorized(userId) {
    return ADMIN_IDS.includes(String(userId || ''));
}

async function authMiddleware(ctx, next) {
    if (isAuthorized(ctx.from?.id)) return next();
    if (ctx.callbackQuery) {
        try { await ctx.answerCbQuery('Akses ditolak.', { show_alert: true }); } catch {}
        return;
    }
    if (ctx.from) return ctx.reply('⛔ Akses ditolak. Anda tidak terdaftar sebagai admin.');
}

module.exports = { encrypt, decrypt, isAuthorized, authMiddleware, ADMIN_IDS };
