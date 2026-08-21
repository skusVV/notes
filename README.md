# Telegram echo bot - NestJS on GCP Cloud Functions

A minimal Telegram webhook handler: every text message it receives is sent straight back to the
same chat, and the sender's Telegram id is logged. Written in TypeScript with NestJS, deployed as a
gen2 Cloud Function, and redeployed automatically by Cloud Build whenever you push to GitHub.

Everything below is done in the browser - the Google Cloud Console UI and Telegram's HTTP API. No
`gcloud` CLI needed.

## Layout

```text
src/
  index.ts                     Cloud Functions entry point (target: telegramBot)
  main.ts                      local dev server (npm run start:local)
  app.module.ts                loads .env via @nestjs/config
  telegram/
    telegram.controller.ts     POST / webhook + GET / health, secret-token check
    telegram.service.ts        calls Telegram sendMessage, logs the sender id
    telegram.types.ts          the slice of the Telegram Update we use
cloudbuild.yaml                what the GitHub push trigger runs
.env.example                   copy to .env for local runs
```

## Configuration

All sensitive values come from the environment, never from source:

| Variable | Meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather. Required. |
| `TELEGRAM_WEBHOOK_SECRET` | Shared secret Telegram echoes back in the `X-Telegram-Bot-Api-Secret-Token` header. If unset, the check is skipped. |
| `PORT` | Local dev only. |

Locally these are read from `.env` (git-ignored). In GCP the same names are injected from Secret
Manager, so `.env` is never uploaded - `.gcloudignore` and `.gitignore` both exclude it.

## Run locally

```bash
cp .env.example .env      # then fill in the real token
npm install
npm run start:local       # Nest on :8080

# or exercise the actual Cloud Functions entry point:
npm run start:function
```

Point Telegram at your machine with a tunnel, e.g. `ngrok http 8080`, then register the webhook as
described at the bottom.

## Push to GitHub

```bash
git add .                 # .env stays out, see .gitignore
git commit -m "Telegram echo bot"
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

## One-time GCP setup (Console UI)

Pick your project in the Console project picker first, and note its **project number** (shown on
the Console home dashboard) - you need it for the service account names below.

### 1. Enable the APIs

**APIs & Services -> Library**, then search for and **Enable** each of:
Cloud Functions API, Cloud Run Admin API, Cloud Build API, Artifact Registry API,
Secret Manager API, Cloud Logging API.

### 2. Store the two secrets

**Security -> Secret Manager -> Create secret**, once per secret:

| Name | Secret value |
| --- | --- |
| `telegram-bot-token` | the token @BotFather gave you |
| `telegram-webhook-secret` | any long random string you invent (keep a copy, you need it for `setWebhook`) |

Leave the rest at defaults and click **Create**. The names must match exactly - they are referenced
by `--set-secrets` in [cloudbuild.yaml](cloudbuild.yaml).

### 3. Let the function read the secrets

For each of the two secrets: open it in Secret Manager, go to the **Permissions** tab ->
**Grant access**.

- New principal: `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`
- Role: **Secret Manager Secret Accessor**

Save. This is the runtime service account of the deployed function; without this the function
starts and immediately fails to boot.

### 4. Let Cloud Build deploy the function

**IAM & Admin -> IAM**, tick **Include Google-provided role grants** at the top right, find the
service account the build will run as (`<PROJECT_NUMBER>@cloudbuild.gserviceaccount.com`, or
`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com` if you pick that one in the trigger in step
6), click the pencil, and **Add** these roles:

- Cloud Functions Developer
- Cloud Run Admin
- Service Account User
- Artifact Registry Writer
- Logs Writer

### 5. Connect the GitHub repository

**Cloud Build -> Repositories**, choose the **2nd gen** tab -> **Create host connection**. Pick your
region, name it (e.g. `github-conn`), and click through the GitHub authorization popup - it installs
the Cloud Build GitHub App and asks which repositories it may access. Then **Link repository** and
select your repo.

### 6. Create the push trigger

**Cloud Build -> Triggers -> Create trigger**:

| Field | Value |
| --- | --- |
| Name | `telegram-echo-bot-deploy` |
| Region | same region you used in step 5 |
| Event | **Push to a branch** |
| Source | the repository you linked, branch `^main$` |
| Configuration | **Cloud Build configuration file (yaml or json)** |
| Location | Repository, file `cloudbuild.yaml` |
| Substitution variables | optional: `_REGION` (default `europe-west1`), `_FUNCTION_NAME` (default `telegram-echo-bot`) |
| Service account | the one you granted roles to in step 4 |

**Create**. From here on, every `git push origin main` makes Cloud Build deploy the function - the
first push also creates it. Watch progress under **Cloud Build -> History**; runtime logs are under
the function's **Logs** tab.

To deploy without pushing, use **Run** on the trigger row.

### Build troubleshooting

**`unable to evaluate symlinks in Dockerfile path: lstat /workspace/Dockerfile: no such file or
directory`**, with a step named `Build` using `gcr.io/cloud-builders/docker` - the trigger is set to
**Dockerfile**, not to this repo's yaml, so it is trying to `docker build` a project that has no
Dockerfile. Fix it in **Cloud Build -> Triggers -> (your trigger) -> Edit -> Configuration**: set
Type to **Cloud Build configuration file (yaml or json)**, Location to **Repository**, and the file
path to `cloudbuild.yaml`. Save, then **Run**. A correct run shows a single step named `deploy` on
`gcr.io/google.com/cloudsdktool/cloud-sdk`. Choosing **Autodetected** also works, but only because
it finds `cloudbuild.yaml`; naming the file explicitly is less surprising.

**`PERMISSION_DENIED` on the deploy step** - the service account chosen in the trigger is missing a
role from step 4. The error message names the permission; re-check the role list under **IAM**.

**The build succeeds but the function crashes on start** - almost always step 3: the runtime service
account cannot read a secret, so `TELEGRAM_BOT_TOKEN` never arrives and `TelegramService` throws on
boot. Check the function's **Logs** tab for `TELEGRAM_BOT_TOKEN is not set`.

**Failure on `--allow-unauthenticated`** - your organization policy blocks public access for
`allUsers`. Remove that flag from `cloudbuild.yaml` and instead grant **Cloud Run Invoker** to
`allUsers` on the service under **Cloud Run -> your service -> Security**, or use whatever your org
policy permits.

### 7. Register the webhook with Telegram

Get the function URL: **Cloud Run -> Services -> telegram-echo-bot** (gen2 functions are Cloud Run
services), copy the URL at the top. Then open this in your browser, substituting your values:

```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<FUNCTION_URL>&secret_token=<WEBHOOK_SECRET>
```

A `{"ok":true,...}` response means it is live - message the bot and it will echo back. Check the
registration any time with `https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo`.

The function URL is stable across redeploys, so this only has to be done again if you change the
secret, the function name, or the region.

## Behaviour notes

- The webhook always answers `200` even when the outbound `sendMessage` fails, so Telegram does
  not retry the same update indefinitely. Failures are logged to Cloud Logging.
- Every update logs the sender's Telegram user id (and `@username` when present) plus the chat id,
  so you can trace who talked to the bot in Cloud Logging.
- Requests with a missing or wrong secret token get `401` and are never processed.
- Non-text updates (stickers, joins, and so on) are acknowledged and ignored.
- The Nest app is bootstrapped once per instance and reused across invocations, so only cold
  starts pay for it.
