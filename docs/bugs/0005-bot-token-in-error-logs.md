---
id: 0005-bot-token-in-error-logs
state: OPEN
severity: high
attempt: 0
max_attempts: 3
branch: fix/0005-bot-token-in-error-logs
acceptance: []
failures: []
---

# BUG-0005 - A failed Telegram call writes the bot token and the message text to the logs

> **OPEN.** Found 2026-11-19 by the spec-verifier during the BUG-0003 security pass, and reproduced
> locally with a fake token (the token appeared 7 times in one log entry). Present since before
> BUG-0003; that fix only repeats it up to 3 times per failed reminder.

## Symptom

When any call to the Telegram API fails (a send error, a 5xx, a timeout), Cloud Logging receives the
whole axios error object. It contains the request URL with the **bot token** in it
(`https://api.telegram.org/bot<token>/sendMessage`) and the request body with the **reply text**,
which can be a reminder title, a note or a transcript. Anyone who can read the project's logs can
then read the token and take over the bot, and can read personal text the code otherwise never logs.

## Reproduction

Unit level: give `TelegramService` an `api` whose `post` rejects with a real `AxiosError` built from
a config with `baseURL: 'https://api.telegram.org/botSECRET123'` and a body `{ text: 'private' }`,
then call a path that logs the error with `logger.error(msg, error as Error)` (for example
`SweeperService.sweep` with a failing `sendReminder`). Expected today: the logged output contains
`SECRET123` and `private`.

## Root cause

`TelegramService` creates two axios instances with the token in `baseURL`
([telegram.service.ts](../../src/telegram/telegram.service.ts), around lines 245 and 252). Their
errors propagate unchanged, and about 30 call sites log them with `logger.error(msg, error as
Error)`. Nest serializes the error, including `config.baseURL`, `config.data`, and the request
and response objects.

## Fix scope

- `src/telegram/telegram.service.ts`: add one response interceptor to both axios instances that
  replaces any error with a plain `Error` (no `config`, `request` or `response`), whose message
  carries only the HTTP method, the Telegram method name (for example `sendMessage`), the HTTP
  status, and Telegram's own `description` if one exists. Keep a numeric `status` property on it so
  callers that read the status (for example `errorCode` in `digest-runner.service.ts`) keep working:
  check them and adapt only inside this file if possible.
- `test/`: a regression test.

Out of bounds: rewording the ~30 log call sites; logging policy elsewhere.

## Invariants (must not break)

- A failed Telegram call still throws, so every existing catch and the 200-to-Telegram contract
  behave as before.
- Reflect mode is unchanged.
- The digest runner still reports `send_failed`, and its log still carries `HTTP <status>`.

## Acceptance criteria (proposed, to lock at READY)

- **repro-fixed:** the reproduction above logs neither the token nor the body text, and the
  error message still names the Telegram method and HTTP status.
- **still-throws:** the sweeper's retry tests (BUG-0003) and the digest runner's `send_failed` test
  still pass unchanged.
- **health:** `GET /` returns 200 `{"status":"ok"}` on the test function.

## Out of scope

Rotating the token. Do that by hand in BotFather after the fix is live, then update the
`TELEGRAM_BOT_TOKEN` secret, because the old token may already be in past log entries.
