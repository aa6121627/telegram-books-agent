import fs from "node:fs/promises";
import path from "node:path";
import { withTelegram, findLatestBook, downloadBook } from "./telegram.js";
import { extractFirstPageCover } from "./cover.js";
import { uploadToDrive } from "./drive.js";
import { uploadCoverAndGetDirectLink } from "./top4top.js";
import {
  wasProcessed, markProcessing, saveBook, markFailed, getState, setState
} from "./firebase.js";

function cleanBookName(fileName) {
  return path.basename(fileName)
    .replace(/\.(pdf|epub|mobi|azw3|djvu|docx?|txt|cbz|cbr|zip|rar)$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const paused = await getState("paused", false);
  if (paused) {
    console.log("Agent is paused in Firebase. Exiting.");
    return;
  }

  await withTelegram(async client => {
    const message = await findLatestBook(client);

    if (!message) {
      console.log("No document posts found in the configured channel.");
      return;
    }

    const messageId = String(message.id);

    if (await wasProcessed(messageId)) {
      console.log(`Latest book ${messageId} was already processed.`);
      return;
    }

    await markProcessing(messageId, {
      channel: process.env.TG_CHANNEL,
      telegramMessageId: message.id,
      originalFileName: message.media?.document?.attributes?.find(a => a.fileName)?.fileName || null
    });

    const workDir = process.env.WORK_DIR || "/mnt/books-work";
    let localFiles = null;

    try {
      localFiles = await downloadBook(client, message, workDir);
      localFiles.coverPath = path.join(workDir, `${message.id}-cover.jpg`);
      await extractFirstPageCover(localFiles.bookPath, localFiles.coverPath);

      const bookName = cleanBookName(localFiles.safeName);
      const drive = await uploadToDrive(
        localFiles.bookPath,
        localFiles.safeName,
        "application/octet-stream"
      );

      const imageUrl = await uploadCoverAndGetDirectLink(client, localFiles.coverPath);

      const record = {
        name: bookName,
        image: imageUrl,
        download: drive.downloadLink,
        driveView: drive.webViewLink,
        driveFileId: drive.id,
        telegram: {
          channel: process.env.TG_CHANNEL,
          messageId: message.id,
          fileName: localFiles.safeName,
          sizeBytes: localFiles.size
        },
        createdAt: Date.now()
      };

      await saveBook(messageId, record);
      await setState("lastProcessedMessageId", messageId);
      console.log("Book processed successfully:", JSON.stringify(record));
    } catch (error) {
      await markFailed(messageId, error);
      throw error;
    } finally {
      if (localFiles) {
        await fs.rm(localFiles.bookPath, { force: true }).catch(() => {});
        await fs.rm(localFiles.coverPath, { force: true }).catch(() => {});
      }
    }
  });
}

main().catch(error => {
  console.error("AGENT_FAILED:", error);
  process.exitCode = 1;
});
