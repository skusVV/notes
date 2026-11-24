---
id: 0005-bot-token-in-error-logs
state: IMPLEMENTED
severity: high
attempt: 0
max_attempts: 3
branch: fix/0005-bot-token-in-error-logs
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: repro-fixed
    assert: "npm test passes and includes a regression test, failing on the pre-fix code, in which a Telegram call through TelegramService's axios instance rejects with a real AxiosError whose config has baseURL 'https://api.telegram.org/botSECRET123' and body text 'private'; the error that reaches the caller, serialized the way Nest's Logger.error prints it (message + stack + JSON of own enumerable properties), contains neither 'SECRET123' nor 'private', and its message names the Telegram method (e.g. 'sendMessage') and the HTTP status"
  - id: file-api-too
    assert: "npm test includes a passing test that the file-download axios instance (baseURL https://api.telegram.org/file/bot<token>) is sanitized the same way: its rejected error contains no token"
  - id: status-kept
    assert: "npm test includes a passing test that the sanitized error keeps a numeric HTTP status at error.response.status (and nothing else under response), so DigestRunnerService's errorCode still logs 'HTTP <status>'; the existing digest-runner send_failed test and the BUG-0003 sweeper retry tests pass unchanged"
  - id: delivery-unchanged
    assert: "With X-Test-Now=2026-12-01T09:00:00+02:00, from user 900000005 POST 'Remind me today at 16:00 to check the oven'; POST /sweep (valid X-Sweep-Secret) with X-Test-Now=2026-12-01T15:45:00+02:00 and the reflected replies contain exactly one string starting with 'Нагадування:' that contains 'oven' (case-insensitive)"
failures: []
---

# BUG-0005 - A failed Telegram call writes the bot token and the message text to the logs

> **READY 2026-11-24** (owner: "fix 0005"). Found 2026-11-19 by the spec-verifier during the BUG-0003 security pass, and reproduced
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
  status, and Telegram's own `description` if one exists. Keep the status at `error.response.status`
  (a plain `{ status }` object, nothing else under `response`), because `errorCode` in
  `digest-runner.service.ts` reads exactly that path and that file is out of scope.
- `test/`: a regression test.

Out of bounds: rewording the ~30 log call sites; logging policy elsewhere.

## Invariants (must not break)

- A failed Telegram call still throws, so every existing catch and the 200-to-Telegram contract
  behave as before.
- Reflect mode is unchanged.
- The digest runner still reports `send_failed`, and its log still carries `HTTP <status>`.

## Acceptance criteria (locked in the frontmatter at READY)

- **repro-fixed:** the reproduction above logs neither the token nor the body text, and the
  error message still names the Telegram method and HTTP status.
- **still-throws:** the sweeper's retry tests (BUG-0003) and the digest runner's `send_failed` test
  still pass unchanged.
- **health:** `GET /` returns 200 `{"status":"ok"}` on the test function.

## Out of scope

Rotating the token. Do that by hand in BotFather after the fix is live, then update the
`TELEGRAM_BOT_TOKEN` secret, because the old token may already be in past log entries.
