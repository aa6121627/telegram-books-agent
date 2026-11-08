import admin from "firebase-admin";
import fs from "node:fs/promises";
import path from "node:path";

function getBucket() {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) throw new Error("Missing FIREBASE_STORAGE_BUCKET");
  return admin.storage().bucket(bucketName);
}

/**
 * Stores a pending book outside the public /book database node.
 * The object is private and addressed only by its generated path.
 */
export async function uploadPendingBook(localPath, messageId, originalName) {
  const bucket = getBucket();
  const objectPath = `pending-books/${String(messageId)}/${path.basename(originalName)}`;
  const file = bucket.file(objectPath);

  await bucket.upload(localPath, {
    destination: file,
    resumable: true,
    validation: "crc32c",
    metadata: {
      contentType: "application/octet-stream",
      metadata: {
        telegramMessageId: String(messageId),
        originalName: String(originalName)
      }
    }
  });

  return { bucket: bucket.name, objectPath };
}

export async function downloadPendingBook(objectPath, destinationPath) {
  if (!objectPath || !objectPath.startsWith("pending-books/")) {
    throw new Error("Invalid pending storage path.");
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await getBucket().file(objectPath).download({ destination: destinationPath });
  const stat = await fs.stat(destinationPath);
  if (!stat.size) throw new Error("Pending book downloaded as an empty file.");
  return stat;
}

export async function deletePendingBook(objectPath) {
  if (!objectPath || !objectPath.startsWith("pending-books/")) return;
  await getBucket().file(objectPath).delete({ ignoreNotFound: true });
}
