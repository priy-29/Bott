const admin = require('firebase-admin');
const { decrypt } = require('./security');

let mainDb;

function initMainDb() {
    if (mainDb) return mainDb;
    if (!admin.apps.length) {
        if (!process.env.BOT_FIREBASE_JSON) throw new Error('BOT_FIREBASE_JSON is required.');
        const serviceAccount = JSON.parse(process.env.BOT_FIREBASE_JSON);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    mainDb = admin.firestore();
    return mainDb;
}

function now() { return Date.now(); }
function cleanId(value) { return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80); }
function colName(value) { return String(value || '').trim().replace(/^\/|\/$/g, ''); }

const MainDB = {
    db: initMainDb,
    async setState(userId, stateData) {
        return initMainDb().collection('botStates').doc(String(userId)).set({ ...stateData, updatedAt: now(), expiresAt: now() + 15 * 60 * 1000 });
    },
    async getState(userId) {
        const snap = await initMainDb().collection('botStates').doc(String(userId)).get();
        if (!snap.exists) return null;
        const data = snap.data();
        if (data.expiresAt && data.expiresAt < now()) {
            await snap.ref.delete().catch(() => {});
            return null;
        }
        return data;
    },
    async clearState(userId) { return initMainDb().collection('botStates').doc(String(userId)).delete(); },
    async addTarget(target) {
        return initMainDb().collection('firebaseTargets').doc(cleanId(target.id)).set({ ...target, createdAt: target.createdAt || now(), updatedAt: now() });
    },
    async getTarget(id) {
        const snap = await initMainDb().collection('firebaseTargets').doc(cleanId(id)).get();
        return snap.exists ? snap.data() : null;
    },
    async getAllTargets() {
        const snap = await initMainDb().collection('firebaseTargets').orderBy('createdAt', 'desc').get().catch(async () => initMainDb().collection('firebaseTargets').get());
        return snap.docs.map(d => d.data());
    },
    async updateTarget(id, data) { return initMainDb().collection('firebaseTargets').doc(cleanId(id)).set({ ...data, updatedAt: now() }, { merge: true }); },
    async updateTargetMonitoring(id, enabled, collections = []) {
        return this.updateTarget(id, { monitoring: { enabled: !!enabled, collections: [...new Set(collections.map(colName).filter(Boolean))] } });
    },
    async deleteTarget(id) {
        const db = initMainDb();
        const batch = db.batch();
        batch.delete(db.collection('firebaseTargets').doc(cleanId(id)));
        const snap = await db.collection('snapshots').where('targetId', '==', String(id)).get();
        snap.docs.forEach(d => batch.delete(d.ref));
        const monitors = await db.collection('events').where('targetId', '==', String(id)).limit(300).get();
        monitors.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
    },
    async getSnapshot(targetId, collection) {
        const snap = await initMainDb().collection('snapshots').doc(`${cleanId(targetId)}_${encodeURIComponent(colName(collection))}`).get();
        return snap.exists ? (snap.data().data || {}) : {};
    },
    async saveSnapshot(targetId, collection, data, meta = {}) {
        return initMainDb().collection('snapshots').doc(`${cleanId(targetId)}_${encodeURIComponent(colName(collection))}`).set({ targetId: String(targetId), collection: colName(collection), data, updatedAt: now(), ...meta });
    },
    async incrementStat(targetId, field, amount = 1) {
        return initMainDb().collection('statistics').doc(String(targetId)).set({ [field]: admin.firestore.FieldValue.increment(amount), updatedAt: now() }, { merge: true });
    },
    async getStats(targetId) {
        const snap = await initMainDb().collection('statistics').doc(String(targetId)).get();
        return snap.exists ? snap.data() : {};
    },
    async getAllStats() {
        const snap = await initMainDb().collection('statistics').get();
        const out = {};
        snap.docs.forEach(d => { out[d.id] = d.data(); });
        return out;
    },
    async addEvent(event) { return initMainDb().collection('events').add({ ...event, createdAt: now() }); },
    async getEvents({ targetId, collection, action, limit = 10 } = {}) {
        let q = initMainDb().collection('events').orderBy('createdAt', 'desc');
        if (targetId) q = q.where('targetId', '==', String(targetId));
        if (collection) q = q.where('collection', '==', colName(collection));
        if (action) q = q.where('action', '==', action);
        const snap = await q.limit(Math.min(Number(limit) || 10, 50)).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async getRecentErrors(limit = 10) {
        const snap = await initMainDb().collection('systemLogs').where('level', '==', 'ERROR').orderBy('createdAt', 'desc').limit(limit).get().catch(() => ({ docs: [] }));
        return snap.docs.map(d => d.data());
    },
    async log(level, message, meta = {}) {
        return initMainDb().collection('systemLogs').add({ level, message: String(message).slice(0, 1000), meta, createdAt: now() });
    },
    async getSystemSettings() {
        const snap = await initMainDb().collection('botSettings').doc('system').get();
        return snap.exists ? snap.data() : { intervalMs: 300000, maxDocs: 1000, batchSize: 200, notifications: true };
    },
    async setSystemSettings(data) { return initMainDb().collection('botSettings').doc('system').set(data, { merge: true }); },
    async getDashboard() {
        const [targets, stats] = await Promise.all([this.getAllTargets(), this.getAllStats()]);
        let eventsToday = 0, errors = 0, created = 0, updated = 0, deleted = 0;
        const start = new Date(); start.setHours(0, 0, 0, 0); const startMs = start.getTime();
        for (const value of Object.values(stats)) {
            errors += Number(value.errors || 0);
            created += Number(value.create || 0);
            updated += Number(value.update || 0);
            deleted += Number(value.delete || 0);
        }
        const events = await this.getEvents({ limit: 50 });
        eventsToday = events.filter(e => Number(e.createdAt || 0) >= startMs).length;
        return { targets: targets.length, activeTargets: targets.filter(t => t.monitoring?.enabled).length, collections: targets.reduce((n, t) => n + (t.monitoring?.collections?.length || 0), 0), eventsToday, errors, created, updated, deleted };
    }
};

const TargetDB = {
    async getTargetFirestore(targetId) {
        const target = await MainDB.getTarget(targetId);
        if (!target) throw new Error('Target tidak ditemukan.');
        const appName = `TARGET_${cleanId(targetId)}`;
        const existing = admin.apps.find(app => app && app.name === appName);
        if (existing) return existing.firestore();
        const creds = JSON.parse(decrypt(target.credentialEncrypted));
        const app = admin.initializeApp({ credential: admin.credential.cert(creds), projectId: target.projectId }, appName);
        return app.firestore();
    },
    async testConnection(creds) {
        let app;
        const id = `TEST_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        try {
            if (!creds?.project_id || !creds?.private_key || !creds?.client_email) throw new Error('Service Account JSON tidak lengkap.');
            app = admin.initializeApp({ credential: admin.credential.cert(creds), projectId: creds.project_id }, id);
            const db = app.firestore();
            const started = Date.now();
            await db.listCollections();
            return { success: true, projectId: creds.project_id, latency: Date.now() - started };
        } catch (error) {
            return { success: false, error: normalizeFirebaseError(error) };
        } finally {
            if (app) await app.delete().catch(() => {});
        }
    },
    async listCollections(targetId) {
        const db = await this.getTargetFirestore(targetId);
        const cols = await db.listCollections();
        return cols.map(c => c.id).sort();
    },
    async listDocuments(targetId, collection, limit = 10, startAfterId = null) {
        const db = await this.getTargetFirestore(targetId);
        let q = db.collection(colName(collection)).orderBy(admin.firestore.FieldPath.documentId()).limit(Math.min(Number(limit) || 10, 50));
        if (startAfterId) {
            const ref = db.collection(colName(collection)).doc(startAfterId);
            q = q.startAfter(ref);
        }
        const snap = await q.get();
        return { docs: snap.docs.map(d => ({ id: d.id, data: d.data() })), hasMore: snap.size === Math.min(Number(limit) || 10, 50) };
    },
    async getDocument(targetId, collection, documentId) {
        const db = await this.getTargetFirestore(targetId);
        const snap = await db.collection(colName(collection)).doc(String(documentId)).get();
        return snap.exists ? { id: snap.id, data: snap.data() } : null;
    },
    async searchDocuments(targetId, collection, field, value, limit = 10) {
        const db = await this.getTargetFirestore(targetId);
        const snap = await db.collection(colName(collection)).where(field, '==', value).limit(Math.min(Number(limit) || 10, 50)).get();
        return snap.docs.map(d => ({ id: d.id, data: d.data() }));
    }
};

function normalizeFirebaseError(error) {
    const code = String(error?.code || '').toLowerCase();
    const msg = String(error?.message || '').toLowerCase();
    if (code.includes('permission') || msg.includes('permission-denied')) return 'Permission Firebase ditolak.';
    if (code.includes('deadline') || msg.includes('timeout')) return 'Koneksi Firebase timeout.';
    if (code.includes('not-found') || msg.includes('not found')) return 'Data tidak ditemukan.';
    if (code.includes('unavailable') || msg.includes('unavailable')) return 'Firebase sedang tidak tersedia.';
    if (code.includes('invalid')) return 'Credential atau konfigurasi Firebase tidak valid.';
    return 'Koneksi Firebase gagal.';
}

module.exports = { MainDB, TargetDB, normalizeFirebaseError };
    
