/**
 * Safe entry point while the approval workflow is being assembled.
 *
 * The previous implementation processed the latest channel document and
 * uploaded it immediately. That behavior is intentionally disabled: the
 * only supported production path must be an authenticated Telegram
 * operator request followed by an explicit approval callback.
 */
async function main() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN GitHub Actions secret.");
  }

  if (String(process.env.ADMIN_TELEGRAM_ID || "") !== "1263813431") {
    throw new Error("ADMIN_TELEGRAM_ID is not configured for the authorized operator.");
  }

  console.log("Approval-bot safeguards are configured.");
  console.log("Automatic channel processing is disabled; no files were downloaded or uploaded.");
  console.log("The interactive update handler must be installed before enabling the schedule.");
}

main().catch(error => {
  console.error("AGENT_FAILED:", error);
  process.exitCode = 1;
});
