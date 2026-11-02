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
    telegram.service.ts        echo, allowlist, voice download, calls sendMessage
    telegram.types.ts          the slice of the Telegram Update we use
  transcription/
    transcription.service.ts   speech to text via Vertex AI (audio/ogg, no transcoding)
cloudbuild.yaml                what the GitHub push trigger runs
.env.example                   copy to .env for local runs
```

## Configuration

All sensitive values come from the environment, never from source:

| Variable | Meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather. Required. |
| `TELEGRAM_WEBHOOK_SECRET` | Shared secret Telegram echoes back in the `X-Telegram-Bot-Api-Secret-Token` header. If unset, the check is skipped. |
| `ALLOWED_USERS` | Comma-separated Telegram user ids allowed to use the bot, e.g. `111111111,222222222`. Anyone else gets a plain refusal message (it does not include their id; the id is in the logs). Empty or unset allows everyone (but `/ingest/*` then answers `401`). Order does not matter. Prod reads the secret `ALLOWED_USERS`, the test function reads `ALLOWED_USERS_TEST` (substitution `_ALLOWED_USERS_SECRET_NAME`). |
| `REMINDER_SWEEP_SECRET` | Shared secret Cloud Scheduler sends in the `X-Sweep-Secret` header when it calls `POST /sweep`, the endpoint that delivers due reminders. **Unset disables `/sweep`** (it answers `401` and delivers nothing) - unlike the webhook secret, "not configured" fails closed. |
| `INGEST_SECRET` | Shared secret for every `POST /ingest/*` endpoint, sent in the `X-Ingest-Secret` header (the iPhone quick-capture Shortcut, see step 9). **Unset disables `/ingest`** (it answers `401`), like `/sweep`. Text sent to `/ingest/message` is handled as if the user named by the body's `userId` typed it in their private chat with the bot; that id must be in `ALLOWED_USERS` (`403` otherwise). With no valid id in `ALLOWED_USERS`, `/ingest` also answers `401`. Anyone holding this secret can write as any allowed user, so do not share it outside people you trust. |
| `REMINDER_SWEEP_INTERVAL_MINUTES` | Optional, default `30`. The sweep's look-ahead: each tick delivers everything due before the next tick, so reminders fire up to this many minutes early rather than late. Keep it **equal to the Cloud Scheduler frequency**. |
| `GCP_PROJECT` | GCP project used for Vertex AI transcription/classification and Firestore. No API key involved. If unset, voice messages are refused politely, classification degrades to plain echo, and reminders are not stored - text echo keeps working. Set automatically on deploy. |
| `FIRESTORE_DATABASE` | Firestore database id reminders are stored in. Code default `(default)`; deployed as `(default)` in production and `test` on the test function via `cloudbuild.yaml`, so the test lane never touches production data. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Local dev only, and only to transcribe locally. Path to a service-account JSON key. |
| `VERTEX_LOCATION` | Optional. Defaults to `global`, which is ~10% cheaper than a pinned region. |
| `TRANSCRIPTION_MODEL` | Optional. Defaults to `gemini-3.5-flash-lite`. |
| `CLASSIFIER_MODEL` | Optional. Defaults to `gemini-3.5-flash-lite`. Model that sorts each message into note / reminder / symptom / question / actor_info / correction / other. |
| `DEFAULT_TIMEZONE` | IANA zone used to resolve "tomorrow at 9" into a real time. Code default is `UTC`; deployed as `Europe/Kyiv` via `cloudbuild.yaml`. An invalid name falls back to UTC with a startup warning rather than throwing. |
| `MAX_VOICE_SECONDS` | Optional, default `300`. Longer voice messages are refused without being downloaded. |
| `PORT` | Local dev only. |

To find your own user id, message the bot and read the `Received message from user <id>` line in
the logs (`Denied user <id>: not in ALLOWED_USERS` for someone not yet on the list); the refusal message itself does not include it.

Locally these are read from `.env` (git-ignored). In GCP the secrets are injected from Secret
Manager and the non-secret settings from `--set-env-vars`, both in [cloudbuild.yaml](cloudbuild.yaml),
so `.env` is never uploaded - `.gcloudignore` and `.gitignore` both exclude it.

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
Secret Manager API, Cloud Logging API, **Cloud Resource Manager API**, **Cloud Scheduler API**
(`cloudscheduler.googleapis.com`), **Vertex AI API** (`aiplatform.googleapis.com`).

**Cloud Scheduler API** is used by the build's `schedule-sweep` step, which runs *after* the function
is already deployed. Without it the build goes red at that step and the reminder tick never exists,
even though the function itself is live.

**Cloud Resource Manager API** is easy to miss and fails confusingly: the deploy resolves your
project id to a project number via `cloudresourcemanager.projects.get`, and without it the build
dies claiming the service account "does not have permission to access projects instance ... (or it
may not exist)" even though the real cause is just the disabled API.

**Vertex AI API** is what transcribes voice messages. Without it, text echo works and voice fails.
Searching the Library for "Vertex AI" no longer finds it: the product was renamed **Gemini
Enterprise Agent Platform** at Google Cloud Next in April 2026, and the search matches the new
label. Go straight to it by service id instead, which did not change:

```text
https://console.cloud.google.com/apis/library/aiplatform.googleapis.com
```

Throughout this file, prefer the `service.googleapis.com` id over a product name when a search
comes up empty - Google renames the labels, not the ids.

### 2. Store the secrets

**Security -> Secret Manager -> Create secret**, once per secret:

| Name | Secret value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | the token @BotFather gave you |
| `TELEGRAM_WEBHOOK_SECRET` | a random string of `A-Z a-z 0-9 _ -` only, e.g. from `openssl rand -hex 24` (keep a copy, you need it for `setWebhook`) |
| `ALLOWED_USERS` | comma-separated Telegram user ids, in any order, e.g. `111111111,222222222`. For a single-user bot, just your own id |
| `REMINDER_SWEEP_SECRET` | another random string of `A-Z a-z 0-9 _ -`, e.g. from `openssl rand -hex 24` (keep a copy; the build's `schedule-sweep` step reads it and puts it in the Cloud Scheduler job's header) |
| `INGEST_SECRET` | another random string of `A-Z a-z 0-9 _ -`, 32+ characters, e.g. from `openssl rand -hex 24` (keep a copy, the iPhone Shortcut in step 9 sends it as a header) |

Stick to that character set for the webhook secret. Telegram rejects anything else in
`secret_token`, and a value containing `&`, `#`, or `+` silently truncates when you paste it into
the `setWebhook` URL - the webhook then registers a prefix of your secret and every update is
rejected with `401`.

`ALLOWED_USERS` is not really a secret, but it rides through Secret Manager so its commas cannot
collide with the commas that separate entries in `--set-secrets`, and so you can change who may use
the bot without editing the repo or redeploying anything but a new revision.

Leave **Replication policy** at *Automatic* and click **Create**. The names are referenced literally
by `--set-secrets` in [cloudbuild.yaml](cloudbuild.yaml) and are **case-sensitive**, so
`telegram-bot-token` and `TELEGRAM_BOT_TOKEN` are two different secrets. If you prefer different
names, change them in both places.

Transcription needs no secret at all. The deployed function calls Vertex AI as its own service
account, so there is no API key to store or rotate - just the IAM grant in step 3b.

The test lane needs its own copy of the sweep secret, `REMINDER_SWEEP_SECRET_TEST`, alongside
`TELEGRAM_BOT_TOKEN_TEST` and `TELEGRAM_WEBHOOK_SECRET_TEST`, so verification can trigger a sweep on
the test function without knowing the production value. The same goes for `INGEST_SECRET_TEST`.

Prod and test also keep **separate allowlists**: prod reads `ALLOWED_USERS` (normally just your own id),
the test function reads `ALLOWED_USERS_TEST`, value `900000001,900000002,900000003,900000004,900000005,900000006,<your id>`.
The six `9000000xx` ids are the verifier's synthetic users. Keep them out of the prod list.

Every secret named in `--set-secrets` must exist **before** the next deploy, or the build fails with
`... versions/latest was not found`. That includes `INGEST_SECRET` (and `INGEST_SECRET_TEST` and
`ALLOWED_USERS_TEST` for the test trigger), even if you never set up the iPhone Shortcut.

**To shorten the prod list to just your own id**: **Security -> Secret Manager -> `ALLOWED_USERS`
-> + New version**, paste your id alone (digits only, no comma), leave *Disable all past secret
versions* unchecked, click **Add new version**. Then **Cloud Build -> Triggers ->
`telegram-echo-bot-deploy` -> Run** so a new revision reads it.

### 3. Let the function read the secrets

For each of the secrets: open it in Secret Manager, go to the **Permissions** tab ->
**Grant access**.

- New principal: `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`
- Role: **Secret Manager Secret Accessor**

Save. This is the runtime service account of the deployed function; without this the function
starts and immediately fails to boot.

Do this for `REMINDER_SWEEP_SECRET` too (and `REMINDER_SWEEP_SECRET_TEST` for the test lane). That
secret is read twice: by the function at boot, and by the build's `schedule-sweep` step through
`availableSecrets` in [cloudbuild.yaml](cloudbuild.yaml). On current projects the build runs as the
same `<PROJECT_NUMBER>-compute@...` account, so one grant covers both. If your trigger uses a
different build service account, grant **Secret Manager Secret Accessor** on this secret to that
account as well, or the step fails with a permission error on `versions/latest`.

### 3b. Let the function call Vertex AI

Same account, different place. **IAM & Admin -> IAM**, find
`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`, click the pencil, **Add another role**,
and pick **Agent Platform User** (`roles/aiplatform.user`). Save. Filter the picker by
`aiplatform.user` if the label has moved again.

**Do not pick a role labelled "AI Platform ..."** - there are two similarly named products and the
naming crosses over:

| Label | Role id | Service | Correct? |
| --- | --- | --- | --- |
| **Agent Platform User** | `roles/aiplatform.user` | `aiplatform.googleapis.com` | **yes** |
| AI Platform Editor / Admin / Developer | `roles/ml.*` | `ml.googleapis.com`, the legacy ML Engine | no |

The old product owns the "AI Platform" *labels* while the new one owns the `aiplatform.*` *ids*.
Granting an "AI Platform" role looks like it worked and then fails at runtime with
`PERMISSION_DENIED` on `aiplatform.googleapis.com`. Prefer **User** over Administrator: using a
model is all this needs.

This is what replaces an API key: rather than storing a credential, you grant the identity the
function already runs as permission to call the model. Without it, text echo works but every voice
message replies "Sorry, I could not transcribe that voice message." and the function logs a
`PERMISSION_DENIED` from `aiplatform.googleapis.com`.

### 3c. Create the Firestore databases and let the function use them

Reminders are stored in Firestore, so create two databases and grant access.

1. **Firestore -> Create database.** Choose **Native** mode (not Datastore). Set the location to
   **`europe-west1`** - this choice is **permanent** for a database and cannot be changed later.
   Leave the id as `(default)`. This is the production store.
2. **Firestore -> Create database** again for the test lane: **Native** mode, location
   **`europe-west1`**, and this time set the **database id to `test`**. The test function runs with
   `FIRESTORE_DATABASE=test` (via `cloudbuild.yaml`), so nothing it does touches production data.
3. **IAM & Admin -> IAM**, find `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`, click the
   pencil, **Add another role**, and pick **Cloud Datastore User** (`roles/datastore.user`). Save.
   This one grant covers both databases. Without it, text and classification still work but every
   reminder replies that it could not be stored.
4. Add **two Time-to-live (TTL)** policies so expired reminders are reaped automatically. On
   **each** database (`(default)` and `test`): **Firestore -> TTL -> Create policy**, once with
   collection group **`reminders`** and once with collection group **`notifications`**, timestamp
   field **`expireAt`** both times. A stored reminder sets `expireAt` to its event time plus 24
   hours, and each of its notifications sets its own to that notification's time plus 24 hours.
   Both policies are needed because Firestore does **not** cascade a delete into subcollections: a
   reaped reminder would otherwise leave its notifications behind, still due.

   Add a **third** policy on each database the same way, with collection group **`pending`** and
   timestamp field **`expiresAt`**. That one holds the single open "who is this person?" question
   per chat, which sets `expiresAt` to 24 hours after it was asked: a question nobody answers
   disappears on its own instead of sitting there forever. The bot also ignores an expired question
   itself, so a late TTL run only delays the cleanup, never the behaviour.

   **Recurring reminders are exempt by design, and need no Console change.** A recurring reminder -
   a birthday, "every Monday at 8am" - is written with **no** `expireAt` field at all, and neither
   are its notifications. A TTL policy only deletes documents where its timestamp field is present,
   so absence means "never expires" with nothing extra to configure. Do not "fix" this by giving
   them a far-future `expireAt`: a far-future date eventually arrives, and a birthday is supposed to
   outlive it.
5. Add the **composite index** the delivery sweep queries through. On **each** database: **Firestore
   -> Indexes -> Composite -> Create index**.
   - Collection **group** id: `notifications`
   - Query scope: **Collection group** (not Collection - the sweep reads every user's notifications
     in one query)
   - Fields: `status` **Ascending**, then `at` **Ascending**
   - Click **Create** and wait for the status to go from *Building* to *Enabled*.

   If you skip this, the sweep fails with a `FAILED_PRECONDITION` whose message contains a Console
   link that creates exactly this index - following that link is an equally valid way to do it.

   If this project already ran the single-notification version, keep the older `reminders`
   (`status` Asc, `remindAt` Asc) index until the first few sweeps have run: it is what the one-time
   backfill reads to turn each legacy `remindAt` into a notification. Once the sweep logs
   `Backfilled 0 legacy reminder(s)` it is no longer used and can be deleted.

### 4. Let Cloud Build deploy the function

**IAM & Admin -> IAM**, tick **Include Google-provided role grants** at the top right, find the
service account the build actually runs as, click the pencil, and **Add** these roles. On current
projects that account is `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com` - the same one the
function runs as - rather than the older `<PROJECT_NUMBER>@cloudbuild.gserviceaccount.com`. The
deploy step's own error output names the account it authenticated as, so check there if a build
fails on permissions.

- Cloud Functions Developer
- Cloud Run Admin
- Service Account User
- Artifact Registry Writer
- Logs Writer
- **Cloud Scheduler Admin** (`roles/cloudscheduler.admin`) - the `schedule-sweep` step creates or
  updates the sweep job with `gcloud scheduler jobs create/update http`. Without it the build fails
  with `PERMISSION_DENIED` on `cloudscheduler.jobs.create`, after the function has already deployed.

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
| Substitution variables | (nothing to set for prod: `_ALLOWED_USERS_SECRET_NAME` and `_INGEST_SECRET_NAME`, `_SWEEP_SECRET_NAME` and `_SWEEP_JOB_NAME` default to `ALLOWED_USERS`, `INGEST_SECRET`, `REMINDER_SWEEP_SECRET` and `reminder-sweep`). Optional: `_REGION` (default `europe-west1`), `_FUNCTION_NAME` (default `telegram-echo-bot`) |
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

**Telegram gets `401` on every update** - the registered `secret_token` does not match
`TELEGRAM_WEBHOOK_SECRET`. The function logs `secret token mismatch (received N chars, expected M)`:
`received 0` means the `setWebhook` call had no `secret_token` at all, and a shorter-than-expected N
usually means the value was truncated in the URL at a `&`, `#`, or `+`. Fix by storing a new version
with a URL-safe value, **Run** the trigger so a new revision picks it up (env-var secrets resolve at
instance start), then re-run `setWebhook`. Telegram retries queued updates once it stops failing.

**`PERMISSION_DENIED` on the deploy step** - the service account chosen in the trigger is missing a
role from step 4. The error message names the permission; re-check the role list under **IAM**.

**`Secret projects/<NUMBER>/secrets/<NAME>/versions/latest was not found`** - one of four things.
The name in `--set-secrets` does not match the secret exactly, **case included** (the path in the
error is what the deploy asked for; compare it to the name in the secret's console URL). The secret has no *enabled* version (a secret is only a container; check its
**Versions** tab). Or it was created as a **regional** secret, whose real path is
`projects/<NUMBER>/locations/<REGION>/secrets/...` - the **Location** column must read *Automatically
replicated*; regional secrets cannot be converted, so delete and recreate. Or, most often, the
secrets live in a **different project** than the trigger: compare the project number in the error
with the one on your console home dashboard. Secrets must sit in the same project as the trigger, or
be referenced by full `projects/<NUMBER>/secrets/<NAME>:latest` path in `--set-secrets` with an
accessor grant in that project.

Note that before the accessor grant exists, a missing secret reports as *Permission denied* rather
than *not found* - GCP masks existence from callers without access, so fix the IAM grant first and
re-read the error.

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

### 8. The reminder sweep schedule (created by the build)

Nothing delivers a reminder until something calls `POST /sweep` on a schedule. **You do not create
that schedule by hand.** The `schedule-sweep` step in [cloudbuild.yaml](cloudbuild.yaml) runs after
every deploy and creates the Cloud Scheduler job if it is missing, or updates it if it exists:

| Field | Value (set by the pipeline) |
| --- | --- |
| Name | `reminder-sweep` (`reminder-sweep-test` on the test function) |
| Region | same as the function (`europe-west1`) |
| Frequency | `*/30 * * * *`, timezone `Europe/Kyiv` |
| Target | `POST <function URL>/sweep` |
| Header | `X-Sweep-Secret` = the latest `REMINDER_SWEEP_SECRET` value |

Because the step overwrites the job on every deploy, **do not edit the job in the Console** - the
next push reverts the change. To change the frequency, edit `--schedule` in `cloudbuild.yaml` and
`REMINDER_SWEEP_INTERVAL_MINUTES` together. Rotating the secret needs only a new secret version and
a **Run** of the trigger: the build rewrites the header and the new revision picks up the value. If
the job is deleted, the next deploy recreates it.

This step needs three things from earlier steps, and fails after the function is already deployed
if any is missing: the **Cloud Scheduler API** (step 1), the **Cloud Scheduler Admin** role on the
build's service account (step 4), and **Secret Manager Secret Accessor** on `REMINDER_SWEEP_SECRET`
(step 3).

To verify after the first successful build: **Cloud Scheduler**, region `europe-west1`, select
`reminder-sweep`, **Force run**, and check **Cloud Logging** for a `Sweep found 0 due reminder(s)`
line. A `401` means the header does not match the secret the function booted with; a new secret
version only reaches the function on a new revision.

The frequency and `REMINDER_SWEEP_INTERVAL_MINUTES` must stay **equal**. The sweep looks ahead one
interval and delivers everything due before the next tick, so a cron slower than the interval leaves
reminders late, and a faster one re-runs the same window (harmless, just wasted calls).

## iPhone: quick note

One press of the Action Button (or a double tap on the back of the phone), say a sentence, and it
lands in the bot exactly as if you had typed it in the chat: it is classified, stored, and the reply
arrives in Telegram. The phone only shows "Sent". This needs no knowledge of the code.

### 9. Set up the quick-note Shortcut

1. **Secret.** **Security -> Secret Manager -> Create secret**: name `INGEST_SECRET`, value a random
   string of 32+ characters (`A-Z a-z 0-9 _ -`). On its **Permissions** tab -> **Grant access**, give
   `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com` the role **Secret Manager Secret
   Accessor**. Make sure the Telegram user id of everyone who will use the Shortcut is in the
   `ALLOWED_USERS` secret. Then **Run** the trigger.
   **Find your user id:** message the bot and read the `Received message from user <id>` line in
   Cloud Logging (see "To find your own user id" above), or ask `@userinfobot` in Telegram. Each person
   puts their **own** id in their own Shortcut.
2. **Address.** **Cloud Run functions -> `telegram-echo-bot` -> Trigger** tab, copy the function URL.
   The Shortcut's full address is `<URL>/ingest/message`.
3. **Shortcut.** On the iPhone open **Shortcuts** (Команди) -> **+**, name it "Нотатка" (or "Note").
   Add these actions in order:
   1. **Dictate Text** (Диктувати текст). Language: auto-detect if offered, otherwise Ukrainian.
   2. **Get Contents of URL** (Отримати вміст URL):
      - URL: `<URL>/ingest/message`
      - Method: **POST**
      - Headers: `X-Ingest-Secret` = the secret from step 1, `Content-Type` = `application/json`
      - Request Body: **JSON**, two fields:
        - `userId` (Number, or Text - digits are accepted either way) = your Telegram user id
        - `text` = the **Dictated Text** variable

      The body then looks like `{"userId": 281473866, "text": "Нотатка: перевірка зв'язку"}`. Without
      `userId` the bot answers `400 invalid_user` - a Shortcut set up before this field existed stops
      working until you add it.
   3. **Show Notification** (Показати сповіщення): "Надіслано" ("Sent").
4. **Bind it to a button** - one of:
   - **Action Button** (iPhone 15 Pro and later, every 16 and 17): **Settings -> Action Button ->
     Shortcut** -> pick "Нотатка".
   - **Back Tap** (iPhone 8 and later): **Settings -> Accessibility -> Touch -> Back Tap -> Double
     Tap** -> "Нотатка". A thick case can block it or cause false triggers.
   - **Lock Screen widget**, or by voice: "Hey Siri, Нотатка" works on any model.
5. **Check.** Run the Shortcut, say "тест нотатки", and the bot's reply should arrive in Telegram.
6. **Keep the secret safe.** The secret lives inside the Shortcut, so never share the Shortcut via an
   iCloud link. If the phone is lost: add a new version of `INGEST_SECRET` in Secret Manager, update
   the Shortcut, and **Run** the trigger so a new revision picks it up.

What the endpoint answers:

| Situation | Response |
| --- | --- |
| missing or wrong `X-Ingest-Secret`, `INGEST_SECRET` not set, or `ALLOWED_USERS` empty or unset | `401`, nothing processed |
| `text` missing, not a string, empty after trimming, or longer than 4000 characters | `400` `{"ok":false,"error":"invalid_text"}` |
| `userId` missing, or not a positive whole number (a number or a string of digits) | `400` `{"ok":false,"error":"invalid_user"}` |
| `userId` not in `ALLOWED_USERS` | `403` `{"ok":false,"error":"user_not_allowed"}`, nothing sent to Telegram |
| otherwise | `200` `{"ok":true}` - also when handling fails afterwards (the failure is logged) |

The checks run top to bottom, so if both `text` and `userId` are wrong the answer is `invalid_text`.
The reply arrives in the private chat of the user named by `userId`.

A line that starts with `/` runs as a command, just like in the chat (`/version`, `/export`).

For the test function, the `testing` trigger sets `_INGEST_SECRET_NAME=INGEST_SECRET_TEST` and
`_ALLOWED_USERS_SECRET_NAME=ALLOWED_USERS_TEST` (so the synthetic `9000000xx` ids are allowed), and
the verifier reads the matching ingest secret from `TEST_INGEST_SECRET` in `.env`.

## Behaviour notes

- The webhook always answers `200` even when the outbound `sendMessage` fails, so Telegram does
  not retry the same update indefinitely. Failures are logged to Cloud Logging.
- Every update logs the sender's Telegram user id (and `@username` when present) plus the chat id,
  so you can trace who talked to the bot in Cloud Logging.
- When `ALLOWED_USERS` is set, anyone not on the list gets a plain refusal message (no id in the message),
  and the attempt is logged with their user id as `Denied user <id>: not in ALLOWED_USERS`. Updates with no
  identifiable sender (channel posts, for example) are refused too. Changing the list means adding a
  new secret version and starting a new revision, since env-var secrets resolve at instance start.
- **Every message is classified** into `note`, `reminder`, `symptom`, `question`, `actor_info`,
  `correction` or `other`, and the bot replies with what it understood - the intent plus whatever
  fields it could extract. One message can produce **several** intents ("I have a headache and
  remind me to call the doctor" is a symptom *and* a reminder) and each is reported separately.
  **Reminders with a clear date and time are now stored** in Firestore; the other intents are still
  only previewed, so a reply that did not store everything it acted on still ends with a note saying
  so (see [docs/architecture.md](docs/architecture.md)).
- **Reminders are captured, resolved, and stored.** The classifier is told the current local time,
  so "haircut on Thursday at 12" is resolved to a concrete instant and written to
  `users/{userId}/reminders/{autoId}`. A reminder that names no clear time is **not** stored - the
  bot asks rather than guessing. `/export` replies with the requesting user's stored reminders and
  people as a single JSON object `{"reminders":[...],"actors":[...]}`.
- **One reminder can have several notify times.** "I have a doctor appointment on the 22nd at 2PM,
  remind me the evening before and the morning of" is one appointment with **two** nudges: the
  reminder keeps a single `eventAt`, and each nudge is its own document under
  `users/{userId}/reminders/{reminderId}/notifications/{autoId}`. "Morning" means 09:00 local and
  "evening" 19:00 local. A message that names no notify time gets exactly one notification, at
  `eventAt`, so the simple case is unchanged. `/export` lists each reminder's notifications with
  their ids, times and statuses.
- **Reminders are delivered by a sweep, early rather than late.** A Cloud Scheduler job POSTs to
  `/sweep` every 30 minutes; each tick sends every notification due before the *next* tick, so a
  nudge for 10:00 arrives at the 09:45-ish tick, up to 30 minutes early and never late. There are
  no quiet hours. A notification is flipped `scheduled -> sent` inside a Firestore transaction
  *before* it is sent, so two overlapping ticks can never notify twice; a send that fails is logged
  and not retried. Each nudge of the same reminder is claimed and sent on its own.
- **Each delivered notification carries OK / +1h / Tomorrow buttons.** `OK` marks **that
  notification** `acked`, `+1h` reschedules it to an hour after the tap, `Tomorrow` to 09:00 local
  the next day. A snooze moves only that notification's time - `eventAt`, when the thing itself
  happens, is never rewritten, and the reminder's other nudges still fire as scheduled. Taps arrive
  on the same webhook, so they pass the same secret check and the same `ALLOWED_USERS` gate, and a
  notification can only be moved by the user who created it.
- **A new person in a reminder is asked about once.** When a reminder names somebody the bot does
  not know yet - a proper name or a relation, never a generic role like "the doctor" - it replies to
  your message asking who that is. Whatever you answer is stored verbatim as that person's notes
  under `users/{userId}/actors/{autoId}`; answering "no" (or `ні`, `нет`, `не`, `nope`, ...) records
  the decline instead, and neither the person nor the decline is ever asked about again. Only one
  question is asked per message however many new names it carried, the open question lives in
  Firestore (`users/{userId}/pending/{chatId}`, expiring after 24h) rather than in memory, and a
  reply that matches no open question is handled as an ordinary new message. Names are normalised to
  their dictionary form by the classifier, so "Антона" and "Антону" both resolve to "Антон".

- **`X-Test-Now` is test-only.** On the test function (`TEST_REFLECT_REPLY=true`) an
  `X-Test-Now: 2026-09-16T09:00:00+03:00` header pins "now" for that one request, so relative-date
  resolution is deterministic in verification. Production has reflection off and ignores the header
  entirely - the same trust boundary as reply reflection.
- A field the message did not state stays **absent** rather than being guessed - a reminder with no
  lead time says so, and a symptom with no stated severity says so. Confidence below 0.5 makes the
  bot ask instead of filing; between 0.5 and 0.8 it acts but shows the score so a misread is
  visible. If the model call fails entirely the message falls back to `other` and the reply still
  goes out, because a classification failure must never swallow a message.
- **Commands never reach the model.** Anything starting with `/` is routed in code, which matters
  because Telegram sends `/start` on first contact. `/start` and `/help` print usage.
- **Voice messages** are transcribed, and the transcript is quoted back above the classification
  so you can see what speech recognition actually heard. Telegram records voice notes as
  Opus in an OGG container and Gemini accepts `audio/ogg` directly, so nothing transcodes the audio
  and there is no ffmpeg in the image. The language is auto-detected per message - verified with
  Ukrainian and English - so there is nothing to configure and no need to declare a language. A transcript longer than Telegram's 4096-character limit is
  split across several replies. Only the duration and transcript *length* are logged, never the
  text, since these are private notes.
- The allowlist is checked **before** a voice message is downloaded or sent to the model, so a
  non-allowed sender cannot run up the Gemini bill. Voice notes longer than `MAX_VOICE_SECONDS` are
  refused without being downloaded at all.
- Requests with a missing or wrong secret token get `401` and are never processed.
- Non-text, non-voice updates (stickers, joins, and so on) are acknowledged and ignored.
- The Nest app is bootstrapped once per instance and reused across invocations, so only cold
  starts pay for it.
