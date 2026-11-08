import { runBot } from "./approval-bot.js";

runBot().catch(error => {
  console.error("BOOK_APPROVAL_BOT_FAILED:", error);
  process.exitCode = 1;
});
