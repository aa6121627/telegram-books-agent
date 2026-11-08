const API_BASE = "https://api.telegram.org";

function getToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  return token;
}

export async function telegramApi(method, payload = {}) {
  const response = await fetch(`${API_BASE}/bot${getToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000)
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram Bot API ${method} failed: ${data?.description || response.statusText}`);
  }
  return data.result;
}

export function sendMessage(chatId, text, options = {}) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    ...options
  });
}

export function editMessageText(chatId, messageId, text, options = {}) {
  return telegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...options
  });
}

export function answerCallbackQuery(callbackQueryId, text = "", showAlert = false) {
  return telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
    show_alert: showAlert
  });
}

export function sendPhoto(chatId, photo, caption = "", options = {}) {
  return telegramApi("sendPhoto", {
    chat_id: chatId,
    photo,
    ...(caption ? { caption } : {}),
    ...options
  });
}

export function sendDocument(chatId, document, caption = "", options = {}) {
  return telegramApi("sendDocument", {
    chat_id: chatId,
    document,
    ...(caption ? { caption } : {}),
    ...options
  });
}

export function getUpdates(offset = 0, limit = 100) {
  return telegramApi("getUpdates", {
    offset,
    limit,
    timeout: 0,
    allowed_updates: ["message", "callback_query"]
  });
}

export function getMe() {
  return telegramApi("getMe");
}
