const BOT = "top4top_bot";

function urlsFrom(text) {
  return String(text || "").match(/https?:\/\/[^\s<>()]+/g) || [];
}

export async function uploadCoverAndGetDirectLink(client, coverPath) {
  await client.sendMessage(BOT, { message: "/start" });
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Snapshot recent bot messages so we only inspect the response to this upload.
  const before = new Set();
  for await (const message of client.iterMessages(BOT, { limit: 10 })) {
    before.add(String(message.id));
  }

  // The input is a JPG; send it as a photo, not as a forced document.
  await client.sendFile(BOT, {
    file: coverPath,
    forceDocument: false
  });

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2500));

    for await (const message of client.iterMessages(BOT, { limit: 15 })) {
      if (before.has(String(message.id))) continue;

      const links = urlsFrom(message.message);
      if (!links.length) continue;

      const directImage = links.find(url =>
        /\.(jpe?g|png|webp)(\?[^\s]*)?$/i.test(url) ||
        /top4top\.(io|net|org)\//i.test(url)
      );

      if (directImage) return directImage;
      if (links.length === 1) return links[0];
    }
  }

  throw new Error("Top4Top did not return a link within 60 seconds. Check the bot's latest reply and its accepted upload format.");
}
