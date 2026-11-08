
export default {
  async fetch(request, env) {
    // 1. اختبار عمل Worker
    if (request.method !== "POST") {
      return new Response("Telegram webhook is ready.", {
        status: 200
      });
    }

    // 2. قراءة Secret المرسل من Telegram
    const suppliedSecret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

    // 3. التأكد من وجود Secret في إعدادات Worker
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      console.error("DEBUG_100: Worker secret missing");

      return new Response("DEBUG_100", {
        status: 500
      });
    }

    // 4. التأكد من وصول Telegram Header
    if (!suppliedSecret) {
      console.error("DEBUG_101: Telegram header missing");

      return new Response("DEBUG_101", {
        status: 401
      });
    }

    // 5. مقارنة القيمتين دون طباعة الأسرار
    if (suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
      console.error("DEBUG_102: Secret mismatch");

      return new Response("DEBUG_102", {
        status: 401
      });
    }

    console.log("DEBUG_200: Secret verification successful");

    // 6. قراءة تحديث Telegram
    let update;

    try {
      update = await request.json();
    } catch (error) {
      console.error("DEBUG_300: Invalid Telegram JSON");

      return new Response("Invalid JSON", {
        status: 400
      });
    }

    // 7. التأكد من صحة التحديث
    if (!update || !Number.isInteger(update.update_id)) {
      console.error("DEBUG_301: Invalid Telegram update");

      return new Response("Invalid Telegram update", {
        status: 400
      });
    }

    console.log("DEBUG_400: Telegram update received", update.update_id);

    // 8. التأكد من إعدادات GitHub
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
      console.error("DEBUG_500: GitHub configuration missing", {
        tokenExists: Boolean(env.GITHUB_TOKEN),
        repositoryExists: Boolean(env.GITHUB_REPOSITORY)
      });

      return new Response("GitHub configuration missing", {
        status: 500
      });
    }

    // 9. إرسال التحديث إلى GitHub Actions
    let response;

    try {
      response = await fetch(
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
            client_payload: {
              update: update
            }
          })
        }
      );
    } catch (error) {
      console.error("DEBUG_501: GitHub network request failed", {
        error: String(error)
      });

      return new Response("GitHub network request failed", {
        status: 502
      });
    }

    // 10. فحص نتيجة GitHub
    if (!response.ok) {
      const detail = await response.text();

      console.error("DEBUG_502: GitHub dispatch failed", {
        status: response.status,
        detail: detail.slice(0, 500)
      });

      return new Response("GitHub dispatch failed", {
        status: 502
      });
    }

    // 11. نجاح إرسال التحديث
    console.log("DEBUG_600: GitHub dispatch successful", update.update_id);

    return Response.json({
      ok: true,
      update_id: update.update_id
    });
  }
};
