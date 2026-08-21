# Telegram echo bot - NestJS on GCP Cloud Functions

A minimal Telegram webhook handler: every text message it receives is sent straight back to the
same chat. Written in TypeScript with NestJS, deployed as a gen2 Cloud Function, and redeployed
automatically by Cloud Build whenever you push to GitHub.

## Layout

```text
src/
  index.ts                     Cloud Functions entry point (target: telegramBot)
  main.ts                      local dev server (npm run start:local)
  app.module.ts                loads .env via @nestjs/config
  telegram/
    telegram.controller.ts     POST / webhook + GET / health, secret-token check
    telegram.service.ts        calls Telegram sendMessage
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

Point Telegram at your machine with a tunnel, e.g. `ngrok http 8080`, then register the webhook
using the URL below.

## One-time GCP setup

```bash
PROJECT_ID=your-project
REGION=europe-west1
gcloud config set project "$PROJECT_ID"

gcloud services enable \
  run.googleapis.com cloudfunctions.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

# Store the secrets (values are typed in, not committed)
printf '%s' 'PASTE_BOT_TOKEN' | gcloud secrets create telegram-bot-token --data-file=-
openssl rand -hex 32 | gcloud secrets create telegram-webhook-secret --data-file=-

# Let the function's runtime service account read them
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
for S in telegram-bot-token telegram-webhook-secret; do
  gcloud secrets add-iam-policy-binding "$S" \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
done

# Let Cloud Build deploy functions
for ROLE in roles/cloudfunctions.developer roles/run.admin roles/iam.serviceAccountUser \
            roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" --role="$ROLE"
done
```

## Auto-deploy on GitHub push

This folder is the repo root. Push it to GitHub first:

```bash
git init -b main
git add .                 # .env stays out, see .gitignore
git commit -m "Telegram echo bot"
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

Connect the repo once (this opens a browser to authorize the Cloud Build GitHub App):

```bash
gcloud builds connections create github github-conn --region="$REGION"
gcloud builds repositories create my-repo \
  --remote-uri=https://github.com/<owner>/<repo>.git \
  --connection=github-conn --region="$REGION"
```

Then create the push trigger:

```bash
gcloud builds triggers create github \
  --name=telegram-echo-bot-deploy \
  --region="$REGION" \
  --repository="projects/$PROJECT_ID/locations/$REGION/connections/github-conn/repositories/my-repo" \
  --branch-pattern='^main$' \
  --build-config=cloudbuild.yaml \
  --substitutions=_REGION=$REGION
```

From here on, `git push origin main` triggers Cloud Build, which runs `gcloud functions deploy`
and replaces the running function. Watch it with
`gcloud builds list --region=$REGION --limit=5` or in the Cloud Build console.

## Register the webhook (once, after the first deploy)

```bash
URL=$(gcloud functions describe telegram-echo-bot --gen2 --region="$REGION" --format='value(url)')
TOKEN=$(gcloud secrets versions access latest --secret=telegram-bot-token)
SECRET=$(gcloud secrets versions access latest --secret=telegram-webhook-secret)

curl -sS "https://api.telegram.org/bot$TOKEN/setWebhook" \
  -d "url=$URL" -d "secret_token=$SECRET"
```

The function URL is stable across redeploys, so this only has to be done again if you change the
secret or the function name. Verify with
`curl -sS "https://api.telegram.org/bot$TOKEN/getWebhookInfo"`.

## Behaviour notes

- The webhook always answers `200` even when the outbound `sendMessage` fails, so Telegram does
  not retry the same update indefinitely. Failures are logged to Cloud Logging.
- Every update logs the sender's Telegram user id (and `@username` when present) plus the chat id,
  so you can trace who talked to the bot in Cloud Logging.
- Requests with a missing or wrong secret token get `401` and are never processed.
- Non-text updates (stickers, joins, and so on) are acknowledged and ignored.
- The Nest app is bootstrapped once per instance and reused across invocations, so only cold
  starts pay for it.
