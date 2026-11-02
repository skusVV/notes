# garmin-ingester

Daily Garmin Personal API -> Firestore sync, a Cloud Run **job** (spec
[0010](../docs/specs/0010-garmin-health-sync.md)). Separate from the bot: its own deploy, never shipped
with it (`.gcloudignore` excludes this folder).

## Run locally

```bash
cd garmin-ingester && npm install && npm test
set -a && . ../.env && set +a
GARMIN_OWNER_USER_ID=<telegram id> FIRESTORE_DATABASE=test BACKFILL_DAYS=1 node dist/ingester.js
```

Needs `GARMIN_API_KEY`, `GCP_PROJECT`, and Application Default Credentials for the `notes` project.
Unset `TELEGRAM_BOT_TOKEN` to run without sending alerts. One JSON line is logged (request count,
dates, counts, outcome) - never the key, token or any health value.

## Console setup

1. **Secret Manager -> Create secret** `GARMIN_API_KEY` with the key as the value.
2. **IAM & Admin -> IAM**: the job's service account gets **Secret Manager Secret Accessor** on
   `GARMIN_API_KEY` and `TELEGRAM_BOT_TOKEN`, plus **Cloud Datastore User**. No secret-write role.
3. **Cloud Build -> Triggers -> Create**: push to `main`, included files `garmin-ingester/**`,
   config `garmin-ingester/cloudbuild.yaml`.
4. **Cloud Run -> Jobs -> garmin-ingester -> Edit -> Variables**: add `GARMIN_OWNER_USER_ID` (your
   Telegram id) and `GARMIN_KEY_EXPIRES_ON` (`YYYY-MM-DD`, the expiry you chose).
5. **Cloud Scheduler -> Create job**: `0 7 * * *`, `Europe/Kyiv`, target the job's execution API,
   OIDC identity with **Cloud Run Invoker**.

## Renewing the key

Garmin Connect Web: delete the current key, create a new one. **Secret Manager -> GARMIN_API_KEY ->
New version**. Then update `GARMIN_KEY_EXPIRES_ON` on the job. No redeploy; the next run backfills any
skipped day.
