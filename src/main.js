import fs from "node:fs/promises";
import path from "node:path";
import { withTelegram, findLatestBook, downloadBook } from "./telegram.js";
import { extractFirstPageCover } from "./cover.js";
import { uploadToDrive } from "./drive.js";
import { uploadCoverAndGetDirectLink } from "./top4top.js";
import {
  wasProcessed, markProcessing, saveBook, markFailed, getState, setState
} from "./firebase.js";

// Convert Arabic-Indic and Persian digits to Western digits for reliable matching.
function normalizeDigits(value) {
  return String(value)
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

/** Determine the grade from the ORIGINAL filename, before removing grade words. */
function detectBookType(originalFileName) {
  const name = normalizeDigits(path.basename(originalFileName || "").replace(/\.(pdf|epub|mobi|azw3|djvu|docx?|txt|cbz|cbr|zip|rar)$/i, "").toLowerCase())
    .replace(/[ـ_\-()[\].]+/g, " ")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ");

  // Match explicit grade shorthand and full Arabic grade names.
  if (/(?:^|\s)3\s*ث(?:انوي)?(?:\s|$)/.test(name) || /الصف\s+الثالث\s+الثانوي/.test(name) || /الثالث\s+الثانوي/.test(name)) return 3;
  if (/(?:^|\s)2\s*ث(?:انوي)?(?:\s|$)/.test(name) || /الصف\s+الثاني\s+الثانوي/.test(name) || /الثاني\s+الثانوي/.test(name)) return 2;
  if (/(?:^|\s)1\s*ث(?:انوي)?(?:\s|$)/.test(name) || /الصف\s+الاول\s+الثانوي/.test(name) || /الاول\s+الثانوي/.test(name)) return 1;

  throw new Error(`Could not detect school grade from original filename: ${originalFileName}`);
}

/** Remove extension, grade labels and year markers from the displayed book name. */
function cleanBookName(fileName) {
  let name = path.basename(fileName || "")
    .replace(/\.(pdf|epub|mobi|azw3|djvu|docx?|txt|cbz|cbr|zip|rar)$/i, "")
    .replace(/[_\-]+/g, " ");

  name = normalizeDigits(name)
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي");

  // Remove full grade labels first, then shorthand labels.
  name = name
    .replace(/الصف\s+(?:الاول|الثاني|الثالث)\s+الثانوي/gi, " ")
    .replace(/(?:الاول|الثاني|الثالث)\s+الثانوي/gi, " ")
    .replace(/(^|\s)[123]\s*ث(?:انوي)?(?=\s|$)/gi, "$1 ");

  // Remove standalone two- or four-digit year tokens (e.g. ٢٧ / ٢٠٢٧ / 2027).
  name = name.replace(/(^|\s)(?:19\d{2}|20\d{2}|\d{2})(?=\s|$)/g, " ");

  return name.replace(/[()[\]{}_-]+/g, " ").replace(/\s+/g, " ").trim();
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

    const originalFileName = message.media?.document?.attributes?.find(a => a.fileName || a.file_name)?.fileName
      || message.media?.document?.attributes?.find(a => a.file_name)?.file_name
      || `telegram-${message.id}.bin`;

    // Detect the grade before cleaning the filename.
    const bookType = detectBookType(originalFileName);
    const bookName = cleanBookName(originalFileName);
    if (!bookName) throw new Error(`Book name became empty after cleaning: ${originalFileName}`);

    await markProcessing(messageId, {
      channel: process.env.TG_CHANNEL,
      telegramMessageId: message.id,
      originalFileName,
      book_type: bookType,
      book_name: bookName
    });

    const workDir = process.env.WORK_DIR || "/mnt/books-work";
    let localFiles = null;

    try {
      localFiles = await downloadBook(client, message, workDir);
      localFiles.coverPath = path.join(workDir, `${message.id}-cover.jpg`);
      await extractFirstPageCover(localFiles.bookPath, localFiles.coverPath);

      const drive = await uploadToDrive(
        localFiles.bookPath,
        localFiles.safeName,
        "application/octet-stream"
      );

      const imageUrl = await uploadCoverAndGetDirectLink(client, localFiles.coverPath);
      const directDownloadUrl = `https://drive.google.com/uc?export=download&id=${drive.id}`;

      // Firebase book node contains only the four fields required by the app.
      const record = {
        book_img: imageUrl,
        book_name: bookName,
        book_type: bookType,
        book_url: directDownloadUrl
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
