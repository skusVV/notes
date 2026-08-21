# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram echo bot: a NestJS (v11, TypeScript) HTTP handler deployed as a **gen2 GCP Cloud
Function**, redeployed automatically by a Cloud Build GitHub push trigger. The repo root *is* the
function source (`--source=.` in [cloudbuild.yaml](cloudbuild.yaml)) - do not move the app into a
subfolder without also updating the trigger's `--build-config` and the deploy step.


## Commands

```bash
npm run build           # nest build -> dist/
npm run start:local     # Nest dev server on $PORT (8080), watch mode
npm run start:function  # build + serve the real Cloud Functions entry point via functions-framework
```

Deploys happen by pushing to the trigger's branch, or via **Run** on the trigger in the Cloud Build
console. The user does **not** want `gcloud` CLI commands - all GCP setup and operations in
[README.md](README.md) are Cloud Console click-paths, so keep any new instructions UI-based.

There is **no test framework configured**. Verify changes by running the actual function entry
point and curling it - this exercises `src/index.ts`, the Nest bootstrap, and the secret check,
which `start:local` does not:

```bash
TELEGRAM_BOT_TOKEN=fake:token TELEGRAM_WEBHOOK_SECRET=testsecret \
  npx functions-framework --target=telegramBot --source=dist --port=8098

curl -s http://localhost:8098/                       # health -> {"status":"ok"}
curl -s -X POST http://localhost:8098/ \
  -H 'content-type: application/json' \
  -H 'x-telegram-bot-api-secret-token: testsecret' \
  -d '{"update_id":1,"message":{"message_id":1,"chat":{"id":42},
       "from":{"id":777888,"is_bot":false,"username":"someone"},"text":"hello"}}'
```

With a fake token the outbound `sendMessage` fails with a 404 from Telegram; the webhook still
answers `200` and logs the error. That is the expected result, not a regression.

## Architecture

**Two entry points, one `AppModule`.** [src/main.ts](src/main.ts) is a plain Nest server for local
work. [src/index.ts](src/index.ts) is what GCP runs: it registers the HTTP function `telegramBot`
and caches a bootstrap *promise*, so Nest initialises once per Cloud Function instance and
concurrent cold-start requests share one instance. Anything that must exist in production has to be
wired into `AppModule`, not into `main.ts`.

**The name `telegramBot` is coupled across three files.** It appears in `http('telegramBot', ...)`
in `src/index.ts`, as `--entry-point` in `cloudbuild.yaml`, and as `--target` in the
`start:function` script. Renaming requires all three.

**The untyped cast in `src/index.ts` is deliberate.** functions-framework ships Express 4 typings
while Nest 11 uses Express 5, so the req/res pair crosses an untyped boundary before being handed to
the Express instance. At runtime Express re-applies its own prototypes to req/res, so this is safe.
Do not "fix" it by pinning Express 4 at the top level - Nest 11's internals expect Express 5.

**Config is environment variables only.** A global `ConfigModule` ([src/app.module.ts](src/app.module.ts))
reads `.env` locally; in GCP the same variable names arrive as real env vars, injected from Secret
Manager by `--set-secrets` in `cloudbuild.yaml`. `TELEGRAM_BOT_TOKEN` is required and
`TelegramService`'s constructor throws without it. `TELEGRAM_WEBHOOK_SECRET` is optional - when
unset the secret-token check is **skipped entirely**, which is why it must be set in any deployed
environment. Adding a new secret means four steps: `.env.example`, a new secret in the Secret
Manager UI, the `--set-secrets` list in `cloudbuild.yaml`, and a **Secret Manager Secret Accessor**
grant to `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com` on that secret (see
[README.md](README.md)).

**Webhook response contract** ([src/telegram/telegram.controller.ts](src/telegram/telegram.controller.ts)):
a missing or wrong `X-Telegram-Bot-Api-Secret-Token` gets `401` and is never processed (timing-safe
compare); everything else gets `200` even when handling throws, so Telegram does not retry the same
update indefinitely. Failures are logged instead. Preserve this - returning 5xx to Telegram causes
retry storms.

**Deploy pipeline.** Push to the trigger's branch -> Cloud Build runs `cloudbuild.yaml` -> a single
`gcloud functions deploy --gen2 --source=.` **inside the build container** (that is the one place
`gcloud` appears; nobody runs it locally). The Google Node.js buildpack compiles TypeScript by
running the **`gcp-build`** script, so `dist/` is never committed and that script is load-bearing
for deploys. The function URL is stable across redeploys, so `setWebhook` only needs re-running if
the function name, region, or secret changes.

**Logging.** `TelegramService` logs the sender's Telegram user id (and `@username` when present)
plus the chat id for every update, including ignored non-text ones. Cloud Logging is the only
observability here; keep the user id in new log lines so updates stay traceable.

## Other agent configs

A `~/.gemini/GEMINI.md` exists at the user level. To pull importable items (instructions, MCP
servers, commands) into Claude Code, reply `/import` to scan and list what's available, then
`/import --yes=<digest>` with the digest from the scan output to apply user-level items.
