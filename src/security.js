
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; 
const IV_LENGTH = 16;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());

if (!ENCRYPTION_KEY || Buffer.from(ENCRYPTION_KEY).length !== 32) {
    throw new Error('FATAL: ENCRYPTION_KEY must be exactly 32 bytes.');
}

function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

function isAuthorized(userId) {
    return ADMIN_IDS.includes(userId?.toString());
}

const authMiddleware = (ctx, next) => {
    if (isAuthorized(ctx.from?.id)) return next();
    return ctx.reply('⛔ Akses ditolak. Anda tidak terdaftar sebagai admin.');
};

module.exports = { encrypt, decrypt, isAuthorized, authMiddleware, ADMIN_IDS };
