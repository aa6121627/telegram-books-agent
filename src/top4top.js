import fs from "node:fs/promises";

const BOT = "top4top_bot";

function urlsFrom(text) {
  return String(text || "").match(/https?:\/\/[^\s<>()]+/g) || [];
}

export async function uploadCoverAndGetDirectLink(client, coverPath) {
  // This is a user-account MTProto action, not Bot API bot-to-bot messaging.
  await client.sendMessage(BOT, { message: "/start" });
  await new Promise(resolve => setTimeout(resolve, 1200));

  const before = new Set();
  for await (const m of client.iterMessages(BOT, { limit: 5 })) before.add(String(m.id));

  await client.sendFile(BOT, {
    file: coverPath,
    forceDocument: true
  });

  const deadline = Date.now() + 45000;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2500));

    for await (const m of client.iterMessages(BOT, { limit: 10 })) {
      if (before.has(String(m.id))) continue;

      const links = urlsFrom(m.message);
      if (!links.length) continue;

      const direct = links.find(url =>
        /\.(jpe?g|png|webp)(\?|$)/i.test(url) ||
        /top4top\.io\/.*\.(jpe?g|png|webp)/i.test(url)
      );

      if (direct) return direct;
      if (links.length === 1) return links[0];
    }
  }

  throw new Error("Top4Top did not return an image URL within 45 seconds. Verify the bot response format and file acceptance.");
}
