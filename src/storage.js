import fs from "node:fs/promises";
import path from "node:path";
import { getStorage } from "firebase-admin/storage";

function getBucket() {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) {
    throw new Error("Missing FIREBASE_STORAGE_BUCKET. Set it to your Firebase Storage bucket name.");
  }
  return getStorage().bucket(bucketName);
}

/** Store a private temporary copy. This does not create a public download URL. */
export async function uploadPendingBook(localPath, messageId, originalName) {
  const bucket = getBucket();
  const safeName = path.basename(String(originalName)).replace(/[^\p{L}\p{N}._ -]/gu, "_");
  const objectPath = `pending-books/${String(messageId)}/${safeName}`;

  await bucket.upload(localPath, {
    destination: objectPath,
    resumable: true,
    validation: "crc32c",
    metadata: {
      contentType: "application/octet-stream",
      metadata: {
        telegramMessageId: String(messageId),
        originalName: safeName,
        temporary: "true"
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
