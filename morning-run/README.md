# morning-run

The morning Cloud Run **job** (specs [0010](../docs/specs/0010-garmin-health-sync.md),
[0022](../docs/specs/0022-morning-run.md)): sync the Garmin Personal API into Firestore with
retries, then ask the bot to send the morning digest. Separate from the bot: its own deploy, never
shipped with it (`.gcloudignore` excludes this folder). Formerly `garmin-ingester/`.

One run, started by Cloud Scheduler at 07:00:

1. Sync Garmin, up to `MORNING_MAX_ATTEMPTS` tries with `MORNING_RETRY_PAUSE_SECONDS` between them.
   A try is good when Garmin answered **and** today's `health_daily` has sleep. A transient failure
   or "no sleep yet" (the watch has not synced) is retried; a rejected key is not.
2. Alert once, on the final outcome (`success`, `auth_rejected`, `transient`), never once per try.
3. Always `POST $BOT_BASE_URL/ingest/digest` with `X-Ingest-Secret` and `{"userId": <owner>}` - also
   after a failed Garmin phase, so a broken Garmin never cancels the digest. Up to 3 tries on a
   network error or `5xx` with a 5 s pause; `400`/`401`/`403` are logged and not retried.
4. Exit `0`. Only a crash before the bot call (no `GARMIN_OWNER_USER_ID`) exits `1`.

Worst case before the digest goes out: 4 pauses of 180 s, so about 07:12-07:15.

## Run locally

```bash
cd morning-run && npm install && npm test
set -a && . ../.env && set +a
GARMIN_OWNER_USER_ID=<telegram id> FIRESTORE_DATABASE=test BACKFILL_DAYS=1 \
  MORNING_MAX_ATTEMPTS=3 MORNING_RETRY_PAUSE_SECONDS=5 \
  BOT_BASE_URL=<bot function URL> node dist/ingester.js
```

Needs `GARMIN_API_KEY`, `GCP_PROJECT`, `INGEST_SECRET`, and Application Default Credentials for the
`notes` project. Unset `TELEGRAM_BOT_TOKEN` to run without sending alerts; leave `BOT_BASE_URL` unset
to skip the digest call (logged). Logged: one JSON line per try, a summary line (outcome, tries,
request count, dates, counts) and a digest line (HTTP status, `sent`, `reason`) - never the key, the
token, `INGEST_SECRET`, the bot's response body or any health value.

## Configuration

| Variable | Where it is set | Meaning |
|---|---|---|
| `GARMIN_API_KEY`, `TELEGRAM_BOT_TOKEN` | Secret Manager, via `cloudbuild.yaml` | Garmin key; bot token for the key alerts. |
| `INGEST_SECRET` | Secret Manager, via `cloudbuild.yaml` (the bot's existing secret) | Sent as `X-Ingest-Secret`. |
| `GCP_PROJECT`, `FIRESTORE_DATABASE`, `BACKFILL_DAYS` | `cloudbuild.yaml` | Rewritten on every deploy. |
| `GARMIN_OWNER_USER_ID` | on the job, once | Owner's Telegram id: whose data, who gets the digest. |
| `GARMIN_KEY_EXPIRES_ON` | on the job, once | `YYYY-MM-DD`, the key's expiry, for the heads-up. |
| `BOT_BASE_URL` | on the job, once | Prod bot function URL, no trailing `/`. |
| `MORNING_MAX_ATTEMPTS` | on the job, optional | Garmin tries per run, default `5`. |
| `MORNING_RETRY_PAUSE_SECONDS` | on the job, optional | Pause between tries, default `180`. |

`cloudbuild.yaml` uses `--update-env-vars` and `--update-secrets`, never `--set-*`: on a Cloud Run job
`--set-env-vars` replaces **every** variable, which would wipe the ones set on the job. With
`--update-*` a redeploy only rewrites the names listed in `cloudbuild.yaml`, so the "on the job"
rows above survive. Keep it that way when adding a variable.

## Console setup (first time)

1. **Secret Manager -> Create secret** `GARMIN_API_KEY` with the key as the value.
2. **Secret Manager** -> `GARMIN_API_KEY`, `TELEGRAM_BOT_TOKEN` and `INGEST_SECRET` -> **Permissions ->
   Grant access**: the job's service account, role **Secret Manager Secret Accessor**. **IAM & Admin
   -> IAM**: the same account gets **Cloud Datastore User**. No secret-write role.
3. **Cloud Build -> Triggers -> Create**: push to `main`, included files `morning-run/**`,
   configuration `morning-run/cloudbuild.yaml`. Push (or **Run** the trigger) to create the job
   `morning-run`.
4. **Cloud Run -> Jobs -> morning-run -> Edit -> Variables & Secrets**: add `GARMIN_OWNER_USER_ID`,
   `GARMIN_KEY_EXPIRES_ON` and `BOT_BASE_URL` (optionally `MORNING_MAX_ATTEMPTS`,
   `MORNING_RETRY_PAUSE_SECONDS`). Check **Task timeout** `1800` s and **Max retries** `0`.
5. **Cloud Run -> Jobs -> morning-run -> Execute** once and check **Logs**: the tries, the digest line,
   the digest in Telegram.
6. **Cloud Scheduler -> Create job**: `0 7 * * *`, `Europe/Kyiv`, target the job's execution API,
   OIDC identity with **Cloud Run Invoker**. **Force run** to check.

To change the digest time: **Cloud Scheduler -> the job -> Edit -> Frequency** (e.g. `30 7 * * *`).
There is no chat command for it.

## Renewing the key

Garmin Connect Web: delete the current key, create a new one. **Secret Manager -> GARMIN_API_KEY ->
New version**. Then update `GARMIN_KEY_EXPIRES_ON` on the job. No redeploy; the next run backfills any
skipped day.
