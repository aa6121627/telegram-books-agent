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

/** Save the public book record under the root node: book/<telegram-message-id>. */
export async function saveBook(messageId, record) {
  const requiredKeys = ["book_img", "book_name", "book_type", "book_url"];
  for (const key of requiredKeys) {
    if (record[key] === undefined || record[key] === null || record[key] === "") {
      throw new Error(`Cannot save book: missing ${key}`);
    }
  }
  if (![1, 2, 3].includes(Number(record.book_type))) {
    throw new Error(`Invalid book_type: ${record.book_type}`);
  }

  const bookRecord = {
    book_img: String(record.book_img),
    book_name: String(record.book_name),
    book_type: Number(record.book_type),
    book_url: String(record.book_url)
  };

  const updates = {};
  updates[`book/${messageId}`] = bookRecord;
  updates[`bookAgent/processed/${messageId}`] = {
    done: true,
    completedAt: Date.now()
  };
  updates[`bookAgent/jobs/${messageId}`] = {
    status: "completed",
    completedAt: Date.now(),
    book_name: bookRecord.book_name,
    book_type: bookRecord.book_type
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
