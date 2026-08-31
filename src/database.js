const admin = require('firebase-admin');
const { decrypt } = require('./security');

// Formatting Private Key secara paksa agar kebal dari error Vercel
let pk = process.env.BOT_FIREBASE_PRIVATE_KEY || '';
pk = pk.split(String.raw`\n`).join('\n').replace(/\\n/g, '\n');

let mainDb;
try {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.BOT_FIREBASE_PROJECT_ID,
                clientEmail: process.env.BOT_FIREBASE_CLIENT_EMAIL,
                privateKey: pk
            })
        });
    }
    mainDb = admin.firestore();
} catch (error) {
    console.error("FATAL ERROR DB INIT:", error);
}

const MainDB = {
    async setState(userId, stateData) {
        await mainDb.collection('botStates').doc(userId.toString()).set(stateData);
    },
    async getState(userId) {
        const doc = await mainDb.collection('botStates').doc(userId.toString()).get();
        return doc.exists ? doc.data() : null;
    },
    async clearState(userId) {
        await mainDb.collection('botStates').doc(userId.toString()).delete();
    },
    async addTarget(targetData) {
        await mainDb.collection('firebaseTargets').doc(targetData.id).set(targetData);
    },
    async getTarget(targetId) {
        const doc = await mainDb.collection('firebaseTargets').doc(targetId).get();
        return doc.exists ? doc.data() : null;
    },
    async getAllTargets() {
        const snapshot = await mainDb.collection('firebaseTargets').get();
        return snapshot.docs.map(doc => doc.data());
    },
    async deleteTarget(targetId) {
        await mainDb.collection('firebaseTargets').doc(targetId).delete();
        await mainDb.collection('snapshots').doc(targetId).delete();
    },
    async updateTargetMonitoring(targetId, enabled, collections = []) {
        await mainDb.collection('firebaseTargets').doc(targetId).update({
            'monitoring.enabled': enabled,
            'monitoring.collections': collections
        });
    },
    async getSnapshot(targetId, collection) {
        const doc = await mainDb.collection('snapshots').doc(`${targetId}_${collection}`).get();
        return doc.exists ? doc.data().data : {};
    },
    async saveSnapshot(targetId, collection, data) {
        await mainDb.collection('snapshots').doc(`${targetId}_${collection}`).set({ data });
    },
    async incrementStat(targetId, field) {
        const ref = mainDb.collection('statistics').doc(targetId);
        await ref.set({ [field]: admin.firestore.FieldValue.increment(1) }, { merge: true });
    }
};

const TargetDB = {
    async getTargetFirestore(targetId) {
        const targetData = await MainDB.getTarget(targetId);
        if (!targetData) throw new Error('Target tidak ditemukan.');

        const appName = `TARGET_${targetId}`;
        const existingApp = admin.apps.find(app => app && app.name === appName);
        if (existingApp) return existingApp.firestore();

        const credsRaw = JSON.parse(decrypt(targetData.credentialEncrypted));
        const newApp = admin.initializeApp({
            credential: admin.credential.cert(credsRaw),
            projectId: targetData.projectId
        }, appName);
        
        return newApp.firestore();
    },

    async testConnection(credsRaw) {
        const tempAppId = `TEST_${Date.now()}`;
        try {
            const app = admin.initializeApp({
                credential: admin.credential.cert(credsRaw),
                projectId: credsRaw.project_id
            }, tempAppId);
            const db = app.firestore();
            await db.listCollections(); 
            await app.delete();
            return { success: true, projectId: credsRaw.project_id };
        } catch (error) {
            const app = admin.apps.find(a => a && a.name === tempAppId);
            if (app) await app.delete();
            return { success: false, error: error.message };
        }
    }
};

module.exports = { MainDB, TargetDB };
