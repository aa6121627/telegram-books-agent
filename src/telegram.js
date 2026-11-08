import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import fs from "node:fs/promises";
import path from "node:path";

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const session = process.env.TG_SESSION;
const channel = process.env.TG_CHANNEL;

export async function withTelegram(callback) {
  if (!apiId || !apiHash || !session || !channel) {
    throw new Error("Missing TG_API_ID, TG_API_HASH, TG_SESSION or TG_CHANNEL");
  }

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 60
  });

  await client.connect();
  try {
    if (!(await client.checkAuthorization())) {
      throw new Error("Telegram MTProto session is not authorized. Recreate TG_SESSION.");
    }
    return await callback(client);
  } finally {
    await client.disconnect();
  }
}

export function getDocumentName(message) {
  const document = message.media?.document;
  if (!document) return null;

  const attr = document.attributes?.find(
    item => item.className === "DocumentAttributeFilename" || item.fileName
  );

  return attr?.fileName || attr?.file_name || `telegram-${message.id}.bin`;
}

export function getDocumentSize(message) {
  return Number(message.media?.document?.size || 0);
}

export async function findLatestBook(client) {
  const entity = await client.getEntity(channel);
  const messages = [];

  for await (const message of client.iterMessages(entity, { limit: 80 })) {
    if (message.media?.document) messages.push(message);
  }

  messages.sort((a, b) => Number(b.id) - Number(a.id));
  return messages[0] || null;
}

export async function downloadBookAndCover(client, message, directory) {
  await fs.mkdir(directory, { recursive: true });

  const originalName = getDocumentName(message);
  const safeName = path.basename(originalName).replace(/[\\/:*?"<>|]/g, "_");
  const bookPath = path.join(directory, `${message.id}-${safeName}`);

  const size = getDocumentSize(message);
  const maxBytes = Number(process.env.MAX_BOOK_MB || 5000) * 1024 * 1024;

  if (!size) throw new Error("Telegram document size is missing.");
  if (size > maxBytes) {
    throw new Error(`Book is larger than MAX_BOOK_MB (${process.env.MAX_BOOK_MB || 5000} MB).`);
  }

  await client.downloadMedia(message, {
    outputFile: bookPath,
    progressCallback: (downloaded, total) => {
      if (total && downloaded % (25 * 1024 * 1024) < 1024 * 1024) {
        console.log(`Telegram download: ${Math.round(downloaded / total * 100)}%`);
      }
    }
  });

  const coverPath = path.join(directory, `${message.id}-cover.jpg`);
  let coverFound = false;
  const channelEntity = await client.getEntity(channel);

  // First try the document's embedded thumbnail.
  try {
    const result = await client.downloadMedia(message, {
      thumb: -1,
      outputFile: coverPath
    });
    coverFound = Boolean(result) || (await fs.stat(coverPath).then(() => true).catch(() => false));
  } catch {}

  // If no embedded thumbnail exists, only accept a photo in the same Telegram album.
  if (!coverFound && message.groupedId) {
    for await (const candidate of client.iterMessages(channelEntity, { limit: 30 })) {
      if (String(candidate.groupedId || "") === String(message.groupedId) && candidate.media?.photo) {
        await client.downloadMedia(candidate, { outputFile: coverPath });
        coverFound = true;
        break;
      }
    }
  }

  if (!coverFound) {
    throw new Error("No cover image found. Add the cover as a Telegram document thumbnail or in the same media album as the book.");
  }

  return { bookPath, coverPath, originalName, safeName, size };
}
