import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = admin.database();

export async function wasProcessed(messageId) {
  const key = String(messageId);
  const snap = await db.ref(`bookAgent/processed/${key}`).get();
  return snap.exists();
}

export async function markProcessing(messageId, details = {}) {
  await db.ref(`bookAgent/jobs/${messageId}`).update({
    status: "processing",
    startedAt: Date.now(),
    ...details
  });
}

export async function saveBook(messageId, record) {
  const updates = {};
  updates[`books/${messageId}`] = record;
  updates[`bookAgent/processed/${messageId}`] = {
    done: true,
    completedAt: Date.now()
  };
  updates[`bookAgent/jobs/${messageId}`] = {
    status: "completed",
    completedAt: Date.now(),
    name: record.name,
    driveFileId: record.driveFileId || null
  };
  await db.ref().update(updates);
}

export async function markFailed(messageId, error) {
  await db.ref(`bookAgent/jobs/${messageId}`).update({
    status: "failed",
    failedAt: Date.now(),
    error: String(error).slice(0, 1000)
  });
}

export async function getState(key, fallback = null) {
  const snap = await db.ref(`bookAgent/state/${key}`).get();
  return snap.exists() ? snap.val() : fallback;
}

export async function setState(key, value) {
  await db.ref(`bookAgent/state/${key}`).set(value);
}
