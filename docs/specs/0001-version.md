---
id: 0001-version
state: IMPLEMENTED
attempt: 0
max_attempts: 3
branch: feat/0001-version
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: version-format
    assert: "POST a /version command update (valid secret token) returns a reflected reply matching /^notes-bot \\d+\\.\\d+\\.\\d+$/"
  - id: auth-401
    assert: "POST any update with a wrong X-Telegram-Bot-Api-Secret-Token returns HTTP 401"
  - id: unknown-command-unchanged
    assert: "POST an /nope command update returns a reflected reply equal to 'I do not know /nope. Try /help.'"
failures: []
---

# 0001 - `/version` command

> This is the pipeline's proving spec. Its job is not to be a great feature - it is to walk the whole
> state machine end to end (implement -> deploy to test -> verify -> merge) with zero Firestore
> complexity, so we trust the machinery before feeding it real work.

## Context

The bot has no way to report which build is live. Add a `/version` command that replies with the
bot's version. Deliberately trivial: a deterministic, model-free command that exercises the full
pipeline and the reply-reflection path.

## Scope

- `src/telegram/telegram.service.ts` - add a `/version` branch to `handleCommand`.
- `test/` (new) - the unit test for the new branch, plus the `npm test` wiring if not present.
- `package.json` - a `test` script if one must be added.

Do **not** touch the controller, the classifier, the transcription service, or any deploy config.

## Contracts

- New command `/version`, routed in `handleCommand` (before classification, like `/start`).
- Reply format: `notes-bot <version>` where `<version>` is a semantic version string
  (`\d+\.\d+\.\d+`). Source it from `package.json` (a constant or an import - implementer's choice);
  do not invent a number.
- No new env var, no new secret, no change to the webhook response contract.

## Invariants (must not break)

- Commands are routed deterministically before the model (`text.startsWith('/')`).
- The webhook still answers `200` for handled updates and `401` only on a wrong secret token.
- Replies set no `parse_mode`.
- Unknown commands still fall through to `I do not know <command>. Try /help.` unchanged.

## Acceptance criteria (locked)

See frontmatter `acceptance`. In words:

- **health:** `GET /` returns `200` with `{"status":"ok"}`.
- **version-format:** a `/version` update returns a reflected reply matching `^notes-bot
  \d+\.\d+\.\d+$`.
- **auth-401:** a POST with a wrong secret token returns `401` (proves the auth path on the test
  function).
- **unknown-command-unchanged:** `/nope` still returns `I do not know /nope. Try /help.`, proving the
  existing command path is intact.

## Out of scope

- Build SHA / commit id in the version string (a constant or `package.json` version is enough).
- Any change to `/start`, `/help`, or classification.
- Persistence - there is none yet, and this command needs none.
