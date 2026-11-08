import input from "input";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  throw new Error("Set TG_API_ID and TG_API_HASH before running npm run auth");
}

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5
});

await client.start({
  phoneNumber: async () => await input.text("Telegram phone number (+country code): "),
  phoneCode: async () => await input.text("Login code: "),
  password: async () => await input.text("2FA password (if enabled): "),
  onError: (error) => console.error(error)
});

console.log("\nLogin successful.");
console.log("Copy this value into Secret Manager as TG_SESSION:\n");
console.log(client.session.save());
await client.disconnect();
