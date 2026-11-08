export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Telegram webhook is ready.", { status: 200 });
    }

    const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!env.TELEGRAM_WEBHOOK_SECRET || suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!update || !Number.isInteger(update.update_id)) {
      return new Response("Invalid Telegram update", { status: 400 });
    }

    const response = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/dispatches`,
      {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "telegram-books-webhook"
        },
        body: JSON.stringify({
          event_type: "telegram_update",
          client_payload: { update }
        })
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      console.error("GitHub dispatch failed:", response.status, detail.slice(0, 500));
      return new Response("Could not dispatch GitHub workflow", { status: 502 });
    }

    return Response.json({ ok: true, update_id: update.update_id });
  }
};
