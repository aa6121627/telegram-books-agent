# Telegram Books AI Agent

Cloud Run Jobs + Cloud Scheduler + Telegram MTProto + Google Drive + Top4Top + Firebase RTDB.

## Important

- This project uses a regular Telegram user session (MTProto) to read the public channel and send the cover to `@top4top_bot`.
- Do not publish `TG_SESSION`, Telegram API credentials, Google OAuth secrets, or Firebase credentials.
- The Top4Top bot currently advertises a 20 MB per-file limit. Covers should be much smaller.
- Cloud Run ephemeral disk is temporary. The job downloads the book locally, uploads it to Drive, then deletes the local copy.
- The initial version processes the newest document post only. It does not scan the full channel backlog.
- The cover must be embedded as the document thumbnail or be part of the same Telegram media album. Otherwise the job stops safely rather than assigning an unrelated image.
- Test with a small permitted book first.

## 1. Telegram API credentials

1. Visit https://my.telegram.org
2. Open API development tools and create an application.
3. Save `api_id` and `api_hash`.
4. On a trusted computer with Node.js 22, install dependencies and run:

```bash
npm install
TG_API_ID="YOUR_API_ID" TG_API_HASH="YOUR_API_HASH" npm run auth
```

5. Complete the login code and 2FA prompt.
6. Copy the printed session string into Google Secret Manager as `TG_SESSION`.
7. Never send the session string in chat or commit it to Git.

## 2. Google Drive OAuth

Use OAuth for your own Google account (not a service account) so the uploaded files belong to your Drive:

1. Create/select a Google Cloud project.
2. Enable Google Drive API.
3. Configure OAuth consent screen.
4. Create an OAuth Client ID (Desktop app).
5. Generate a refresh token for scope `https://www.googleapis.com/auth/drive`.
6. Store Client ID, Client Secret and Refresh Token in Secret Manager.
7. Optionally create a Drive folder and set `GOOGLE_DRIVE_FOLDER_ID`.

The upload uses the Drive API resumable upload implementation in `googleapis`.

## 3. Firebase

Create a dedicated runtime service account and grant it the required Firebase Realtime Database access. Attach that service account to the Cloud Run Job. Set:

- `FIREBASE_DATABASE_URL`

Enable Application Default Credentials by using the Cloud Run service identity. Do not put a Firebase private key in the image.

Database structure:

```json
{
  "books": {
    "TELEGRAM_MESSAGE_ID": {
      "name": "Book name",
      "image": "https://direct-image-url",
      "download": "https://drive.google.com/uc?export=download&id=FILE_ID",
      "driveView": "https://drive.google.com/file/d/FILE_ID/view",
      "driveFileId": "FILE_ID",
      "createdAt": 0
    }
  },
  "bookAgent": {
    "processed": {},
    "jobs": {},
    "state": {
      "paused": false
    }
  }
}
```

## 4. Container environment

Required environment variables:

- `TG_API_ID`
- `TG_API_HASH`
- `TG_SESSION` (Secret Manager)
- `TG_CHANNEL` (public username, without `@` is recommended)
- `GOOGLE_CLIENT_ID` (Secret Manager)
- `GOOGLE_CLIENT_SECRET` (Secret Manager)
- `GOOGLE_REFRESH_TOKEN` (Secret Manager)
- `FIREBASE_DATABASE_URL`
- `MAX_BOOK_MB` (default 5000)
- `WORK_DIR` (default `/mnt/books-work`)

## 5. Cloud Run Job

Enable APIs:

```bash
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  firebase.googleapis.com \
  drive.googleapis.com
```

Build and deploy the container from this folder using Cloud Build or `gcloud run jobs deploy`. Configure:
- Region close to your users/data.
- CPU: 2
- Memory: 2GiB (increase if needed)
- Ephemeral disk mounted at `/mnt` with a size larger than the maximum expected book.
- Task timeout: 2h initially (increase if needed; maximum 168h).
- Retries: 1
- Parallelism: 1

Example build:

```bash
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT_ID/books-agent/books-agent:latest
```

Then create the Cloud Run Job in the console, select the image, add environment variables and Secret Manager references, and mount an ephemeral disk at `/mnt`.

## 6. Daily schedule

In Cloud Run > Jobs > your job > Triggers > Add Scheduler Trigger:
- Schedule: `0 7 * * *`
- Time zone: `Africa/Cairo`
- Service account: one that can invoke this Cloud Run Job.

Cloud Scheduler supports direct scheduled execution of Cloud Run Jobs:
https://cloud.google.com/run/docs/execute/jobs-on-schedule

## 7. First test

Run the Job manually once. Confirm:
1. Telegram session is valid.
2. The configured public channel can be read.
3. The latest post has a document.
4. The cover is detected correctly.
5. Drive upload succeeds and the link opens.
6. Top4Top returns the direct image URL.
7. Firebase receives the record.

## Current implementation boundaries

The current code is the first processing engine, not yet the final operator bot. It intentionally processes only the newest unprocessed document and stops if it cannot confidently identify a cover. The next iteration should add:
- Search backward for the next unprocessed document (not only latest).
- Robust album/thumbnail matching based on the actual channel post layout.
- Top4Top response parsing after a real sample response.
- Telegram Serverless `message` handler commands (`/run`, `/pause`, `/resume`, `/status`, `/lastbook`) connected to a secured Cloud Run trigger.
- Durable upload checkpointing if a Cloud Run task is interrupted during a very large transfer.


## 8. Free deployment alternative: GitHub Actions (no Google Cloud)

This starter can run as a scheduled GitHub Actions job instead of Cloud Run + Cloud Scheduler.

1. Create a **private** GitHub repository and upload this project.
2. In repository Settings > Secrets and variables > Actions, create these repository secrets:
   - `TG_API_ID`
   - `TG_API_HASH`
   - `TG_SESSION`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REFRESH_TOKEN`
   - `GOOGLE_DRIVE_FOLDER_ID` (optional; create an empty secret or remove this env line if unused)
   - `FIREBASE_DATABASE_URL`
   - `FIREBASE_SERVICE_ACCOUNT_JSON` (the complete service-account JSON)
3. Keep `.github/workflows/daily.yml` on the default branch.
4. Open Actions, enable workflows if GitHub asks, then run **Daily Telegram Books Agent** manually once using `Run workflow`.
5. Inspect the run logs and Firebase before relying on the daily schedule.

The workflow is scheduled for 07:17 `Africa/Cairo` and also supports manual runs. It uses GitHub-hosted ephemeral Ubuntu runners, not a server you maintain. The standard runner has 14 GB SSD, and a single job can run for at most 6 hours. `MAX_BOOK_MB=8000` is a conservative configured ceiling, not a guarantee that every 8 GB file will fit; actual free disk space must be checked during the run.

GitHub Free currently includes 2,000 Actions minutes/month for private repositories; public-repository standard runners are free and unlimited. Prefer a private repository because the source contains the project structure, even though secrets are stored separately. Do not commit session strings, OAuth credentials, Firebase service-account JSON, or `.env` files.

Scheduled GitHub workflows can be delayed during busy periods. They are not a hard real-time scheduler. See:
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- https://docs.github.com/en/actions/reference/limits

## 9. Important Firebase permission setup

The service account JSON stored in `FIREBASE_SERVICE_ACCOUNT_JSON` must belong to the Firebase project and have permission to access the Realtime Database. Grant only the minimum role required. Rotate the key if it is ever exposed.

## 10. Channel

The configured public channel username is `altfwok` (the URL is https://t.me/altfwok). The code expects `TG_CHANNEL=altfwok`, without the `@`.


## Telegram approval bot (GitHub Actions)

The current entry point polls Telegram Bot API updates and accepts documents only from the configured operator. It creates a PDF first-page preview, then waits for an explicit approval callback before uploading the book to Google Drive, sending the cover to @top4top_bot, and writing the four-field record under /book.

Required GitHub Actions secrets:
- TELEGRAM_BOT_TOKEN
- TG_API_ID
- TG_API_HASH
- TG_SESSION (must be the same Telegram user account that sends documents to the bot)
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_REFRESH_TOKEN
- GOOGLE_DRIVE_FOLDER_ID (optional)
- FIREBASE_DATABASE_URL
- FIREBASE_SERVICE_ACCOUNT_JSON

The authorized operator ID is configured as 1263813431 in the workflow. No Firebase Storage bucket is used; the source document remains in the operator's Telegram conversation and is downloaded again when approved.

The workflow polls every five minutes. This is not real-time. GitHub-hosted runners have finite disk and execution limits; the configured 8000 MB is only an application-side limit, not a guarantee that an 8 GB file can be processed. PDF is currently the only supported format for first-page cover extraction. Test with a small PDF first.

Important: the Telegram MTProto session must belong to the same user who sends the file to the bot. The code matches the Bot API message ID against the outgoing message in that user's dialog with the bot. This must be verified with a real test message before relying on the workflow.
