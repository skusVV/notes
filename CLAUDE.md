# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram echo bot: a NestJS (v11, TypeScript) HTTP handler deployed as a **gen2 GCP Cloud
Function**, redeployed automatically by a Cloud Build GitHub push trigger. The repo root *is* the
function source (`--source=.` in [cloudbuild.yaml](cloudbuild.yaml)) - do not move the app into a
subfolder without also updating the trigger's `--build-config` and the deploy step.

Planned next: a persistence layer turning the bot into a personal memory (reminders, symptom
tracking, notes, retrieval, people). Nothing is implemented yet - the design, the build order and
the decisions already settled live in [docs/architecture.md](docs/architecture.md). Read it before
adding storage, a classifier, or anything scheduled.


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
[README.md](README.md)). The Secret Manager secrets are named `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, and `ALLOWED_USERS`, matching the env vars; those names are case-sensitive and referenced
literally by `--set-secrets`, so a mismatch fails the deploy with `... versions/latest was not
found`. Non-secret settings (`GCP_PROJECT`, `VERTEX_LOCATION`, `TRANSCRIPTION_MODEL`,
`MAX_VOICE_SECONDS`) travel via `--set-env-vars` in the same file instead, so the deployed values
are visible at the deploy boundary rather than implied by code defaults.

**`ALLOWED_USERS` gates every update.** A comma-separated list of Telegram user ids, parsed once in
`TelegramService`'s constructor; unset or empty means everyone is allowed (and logs a warning at
startup), which matches how `TELEGRAM_WEBHOOK_SECRET` behaves when unset. Non-allowed senders get a
refusal message naming their own id rather than silence, and an update with no `from` is refused
whenever a list is configured. It travels via Secret Manager rather than `--set-env-vars` because
that flag treats commas as its own separator - a list would be parsed as multiple env vars.

**Transcription is behind an outcome-named boundary.** `TranscriptionService`
([src/transcription/transcription.service.ts](src/transcription/transcription.service.ts)) exposes
exactly `transcribe(audio: Buffer, mimeType: string): Promise<string>` and is named for what it does,
not for Gemini. Swapping in Cloud Speech-to-Text should touch that one file. It calls Gemini
through **Vertex AI** (`@google/genai` with `vertexai: true`), deliberately *not* the Gemini
Developer API: there is **no API key anywhere**. The function authenticates as its own runtime
service account via Application Default Credentials, so the only setup is enabling
`aiplatform.googleapis.com` and granting `roles/aiplatform.user` to
`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com` - both Console click-paths, and nothing to
store or rotate. Use those ids, not the product names: Vertex AI was renamed **Gemini Enterprise
Agent Platform** in April 2026, so console searches for "Vertex AI" fail while the ids still work.
`roles/aiplatform.user` now displays as **Agent Platform User**; do not confuse it with the
lookalike **AI Platform** roles, which are `roles/ml.*` on the legacy `ml.googleapis.com` and will
not grant model access. Do not "simplify" this back to an API key.
The cost is that a laptop has no GCP identity, so transcribing locally needs
`GOOGLE_APPLICATION_CREDENTIALS` pointing at a downloaded service-account JSON; testing against the
deployed bot avoids that entirely.

Nothing decodes audio - Telegram voice notes are Opus-in-OGG and Gemini takes `audio/ogg` inline, so
there is no ffmpeg step to maintain. Both facts are verified against the deployed bot, including
Ukrainian and English in the same setup: Gemini auto-detects the language, so no language codes are
passed or needed. That is a reason to stay on Gemini rather than Cloud Speech-to-Text, which wants
an explicit `languageCodes` list per request. Unlike `TelegramService`, this service **must not throw** when
unconfigured: with no `GCP_PROJECT` it logs a warning, `available` returns false, and voice messages
get a "not configured" reply so text echo keeps working. Because credentials resolve lazily, a
missing **Vertex AI User** grant does not fail construction - it surfaces as a `PERMISSION_DENIED`
on the first `transcribe()` call, caught by `handleVoice`.

**Classification is the branch point, behind the same kind of boundary as transcription.**
`ClassifierService` ([src/classifier/classifier.service.ts](src/classifier/classifier.service.ts))
takes a message plus a `ClassifierContext` and returns `ClassificationResult` - an **array** of
intents, not one label, because "I have a headache and remind me to call the doctor" is legitimately
two. It uses Gemini structured output (`responseMimeType: 'application/json'` plus a
`responseSchema`) at `temperature: 0`, so the same message does not land in two different places on
two tries. Like `TranscriptionService` it must **not throw** when `GCP_PROJECT` is missing: `available`
returns false and `TelegramService` falls back to plain echo.

Three invariants in that file are deliberate and easy to break. First, `parse`/`coerceItem` never
propagate a bad model response - unknown intents are dropped, out-of-range confidence is clamped,
and anything unusable becomes a single `other` item via `fallbackResult`, because a malformed reply
must not turn into a 500. Second, an intent whose payload fails validation (a `reminder` with no
title, a `symptom` with no type) has its confidence forced *below* `CONFIDENCE_ASK` rather than being
repaired, so the existing clarify branch handles it instead of the bot inventing the missing half.
Third, absent fields stay absent - `severity` in particular is never inferred from words like
"bad", since one fabricated number corrupts every later average. `ClassifierContext` already carries
`knownSymptomTypes`, `knownActors` and `previousText`; they are passed empty until Firestore lands,
and filling them is what stops the model minting a new slug for every wording.

`TelegramService.route` is the branch table: text and voice converge there, one handler per intent,
and each handler currently only *composes a reply* because nothing is persisted yet. Commands are
routed before classification (`text.startsWith('/')`) - load-bearing, because Telegram sends
`/start` on first contact and it would otherwise be classified as prose. Replies deliberately set no
`parse_mode`: they embed the user's own words, and Markdown would break on a stray underscore in a
transcript. The `NOT_STORED_NOTICE` on every reply exists so the bot never implies it kept
something; delete it in the same change that adds storage.

**Two ordering rules in `handleUpdate` are load-bearing.** The `ALLOWED_USERS` gate must run
*before* any voice download or model call, otherwise a stranger can run up the Gemini bill; and the
"is this an update we handle" check must run *before* the gate, so unhandled types (stickers, joins)
stay silent instead of drawing a refusal reply. `MAX_VOICE_SECONDS` and the ~15 MB size cap are
checked before the download for the same reason. The size cap is 15 MB, not 20 MB, because Gemini's
20 MB request ceiling counts the base64 payload, which inflates bytes by 4/3.

**Replies are chunked.** `sendMessage` splits at 4096 characters because Telegram rejects anything
longer and a few minutes of speech transcribes past it. Keep new outbound text going through it.

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
