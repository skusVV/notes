---
id: 0003-reminder-delivery
state: VERIFIED
attempt: 0
max_attempts: 3
branch: feat/0003-reminder-delivery
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: sweep-auth
    assert: "POST /sweep with a missing or wrong X-Sweep-Secret returns HTTP 401 and delivers nothing"
  - id: due-delivered
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Remind me to take pills today at 10:00' from user id U1 (creates a scheduled reminder at remindAt 2026-09-16T10:00:00+03:00); then POST /sweep with a valid X-Sweep-Secret and X-Test-Now=2026-09-16T09:45:00+03:00; the reflected replies are non-empty (a delivery was composed) and a following '/export' from U1 shows that reminder with status == 'sent'. Proves the look-ahead window: a reminder 15 minutes in the future still fires."
  - id: not-yet-due
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Remind me today at 11:00' from user id U2; then POST /sweep with a valid secret and X-Test-Now=2026-09-16T09:45:00+03:00; the reflected replies contain no delivery for U2 and '/export' from U2 shows status == 'scheduled' (11:00 is beyond the 30-minute look-ahead)"
  - id: idempotent-no-double-send
    assert: "After due-delivered, a second identical POST /sweep (same secret, same X-Test-Now=2026-09-16T09:45:00+03:00) returns reflected replies with no delivery for U1's reminder, because its status is now 'sent' and the sweep query matches only 'scheduled'"
  - id: callback-ok-acks
    assert: "Read U1's reminder id from '/export'. POST a callback_query update (valid webhook secret, from = U1) with data 'rem:ok:{id}'; '/export' from U1 then shows that reminder with status == 'acked'"
  - id: callback-snooze-1h
    assert: "Create and deliver a reminder for user id U3 (capture at 2026-09-16T10:00:00+03:00, sweep at 09:45 so status == 'sent'). POST a callback_query from U3 with data 'rem:1h:{id}' and X-Test-Now=2026-09-16T10:05:00+03:00; '/export' from U3 shows status == 'scheduled' and remindAt == '2026-09-16T11:05:00+03:00'"
  - id: callback-tomorrow
    assert: "For a delivered reminder owned by user id U4, POST a callback_query from U4 with data 'rem:tmrw:{id}' and X-Test-Now=2026-09-16T22:00:00+03:00; '/export' from U4 shows status == 'scheduled' and remindAt == '2026-09-17T09:00:00+03:00' (next day, 09:00 local)"
  - id: callback-not-owner
    assert: "For a delivered reminder owned by user id U5, POST a callback_query with data 'rem:ok:{id}' but from a different user id U9; U5's reminder status is unchanged and no reschedule/ack occurs"
failures: []
---

# 0003 - Reminder delivery

## Context

Make stored reminders actually fire. Spec [0002](0002-reminders-capture.md) captures and resolves a
reminder but never notifies anyone. This spec adds the delivery half: a scheduled sweep that finds
due reminders and sends them, plus `OK` / `+1h` / `Tomorrow` buttons on each delivered message.

Design settled with the user (see also [../architecture.md](../architecture.md) sections 5, 8):

- **Simple fixed 30-minute sweep, not an adaptive self-scheduling poller.** A Cloud Scheduler cron
  hits a `/sweep` endpoint on the function. A cron is self-healing - a missed tick catches up on the
  next one - whereas a run that reprograms its own next wake means one failed reschedule leaves the
  bot silent forever.
- **Look-ahead sweep - fire early, never late.** Each tick delivers every reminder due *before the
  next tick*: query `remindAt <= now + interval`, not `<= now`. So with 30-minute ticks a reminder
  for 10:00 fires at the 09:45-ish tick that precedes it, up to ~30 minutes early, and never late.
- **No quiet-hours logic** (the user's explicit choice). A reminder fires at the time it names, which
  the user will not set to the middle of the night; a rare late catch-up after downtime is accepted.
- **Buttons.** Each delivery carries an inline keyboard: `OK` (done), `+1h` (snooze one hour),
  `Tomorrow`. Taps arrive as Telegram `callback_query` updates through the existing webhook.

**Depends on 0002 being merged to `main`.** Branch `feat/0003-reminder-delivery` off a `main` that
already has capture, so the reminder documents and `/export` exist. This spec relies on the 0002
additions `chatId`, `userId`, and `remindAt` on each reminder, and `id` + `remindAt` in `/export`.

## Scope

- `src/telegram/telegram.controller.ts` - add `POST /sweep` (auth by `X-Sweep-Secret`, test-mode
  reflection like the webhook); route `callback_query` updates through the existing webhook handler.
- `src/telegram/telegram.service.ts` - handle `callback_query` (parse `callback_data`, apply the
  `ALLOWED_USERS` gate and an owner check, then ack or snooze, and always `answerCallbackQuery`);
  add `sendReminder(...)` that composes the delivery text plus the inline keyboard.
- `src/telegram/sweeper.service.ts` (new) - the sweep orchestration: query due reminders, and for
  each, claim-and-send (see Contracts). Lives in the telegram module, which already imports
  reminders, to avoid a dependency cycle.
- `src/telegram/telegram.types.ts` - extend `TelegramUpdate` with `callback_query`; add the
  inline-keyboard / callback types.
- `src/reminders/reminders.service.ts` (+ types) - add `findDue(cutoff)` (a `reminders`
  collection-group query on `status == 'scheduled'` and `remindAt <= cutoff`), `claimForSend(ref)`
  (the transaction), `markSent`, `ack(userId, id)`, `snooze(userId, id, newRemindAt)`, and
  `getOwned(userId, id)` for the owner check.
- `src/clock/clock.service.ts` - helpers for the snooze targets: `tap + 1h`, and "next calendar day
  at 09:00 local".
- `cloudbuild.yaml` - add `REMINDER_SWEEP_SECRET` to `--set-secrets` via a `_SWEEP_SECRET_NAME`
  substitution (prod `REMINDER_SWEEP_SECRET`, test `REMINDER_SWEEP_SECRET_TEST`), and
  `REMINDER_SWEEP_INTERVAL_MINUTES` to `--set-env-vars` (default 30).
- `.env.example` - the new secret, the interval, and the verifier's `TEST_SWEEP_SECRET`.
- `README.md` - Console click-paths: the two Secret Manager secrets + accessor grant, the composite
  collection-group index on `reminders (status, remindAt)`, and the Cloud Scheduler job.
- `test/` - unit tests for the deterministic pieces (see Acceptance).

Out of bounds without returning to `DRAFT`: the classifier, the transcription service, and 0002's
capture/resolution code (this spec reads what 0002 writes, it does not change it).

## Contracts

**`POST /sweep`.** Auth: an `X-Sweep-Secret` header, timing-safe compared to `REMINDER_SWEEP_SECRET`.
Missing/wrong -> `401`, no work. If `REMINDER_SWEEP_SECRET` is unset the endpoint is **disabled**
(logs a warning, does nothing) - an open sweep endpoint must never deliver. On success it runs the
sweep and returns `200`; in test mode (`TEST_REFLECT_REPLY=true`) the body is the same reflected
shape as the webhook, `{ok:true, replies:[...]}`, carrying every delivery composed this run. "Now" is
`ClockService.now()`, overridable by `X-Test-Now` in test mode only.

**The sweep.** `cutoff = now + REMINDER_SWEEP_INTERVAL_MINUTES`. `findDue(cutoff)` returns every
reminder (across all users) with `status == 'scheduled'` and `remindAt <= cutoff`, via a `reminders`
collection-group query. For each, **claim then send**:

1. In a Firestore transaction, re-read the doc; if it is still `scheduled`, set `status = 'sent'` and
   `sentAt = now`. If it is not `scheduled` any more, abandon it (another tick won the race).
2. Only the transaction winner composes and sends the delivery. This ordering is what stops two
   overlapping ticks double-notifying.
3. A Telegram send that fails is logged and left as `sent` (not retried, not reverted) for v1. Losing
   a delivery is rarer and less bad here than double-sending; a lease-based retry is a later
   hardening. (With a fake token in the test lane the send 404s after the reflection sink has already
   captured the message, exactly as the existing echo test does.)

**Delivery message.** `sendReminder` sends to the reminder's `chatId`: a short line naming the
reminder `title` and its local `eventAt`, no `parse_mode`, with an inline keyboard of three buttons
whose `callback_data` is `rem:ok:{id}`, `rem:1h:{id}`, `rem:tmrw:{id}` (well under Telegram's 64-byte
`callback_data` limit).

**`callback_query` handling.** Taps arrive on the existing webhook `POST /` (so they are already
covered by the webhook-secret check). For each:

- Apply the `ALLOWED_USERS` gate to `callback_query.from.id`, then an **owner check**: load the
  reminder by id and proceed only if its `userId` equals `from.id`. A non-owner (or unknown id) is
  refused with no state change.
- `rem:ok`  -> `status = 'acked'`; no time change.
- `rem:1h`  -> `remindAt = tapTime + 1 hour`; `status = 'scheduled'` (re-armed for the next sweep).
- `rem:tmrw` -> `remindAt = next calendar day at 09:00 local (DEFAULT_TIMEZONE)`; `status = 'scheduled'`.
- Always call `answerCallbackQuery` (stops Telegram's spinner) with a short confirmation; on `ok`,
  best-effort remove the keyboard via `editMessageReplyMarkup`.

Snooze changes `remindAt` only. `eventAt` (when the thing itself happens) is never moved by a snooze.

**Env / config.** New secret `REMINDER_SWEEP_SECRET` (+ `REMINDER_SWEEP_SECRET_TEST` for the test
function), following the project's four-step secret process (`.env.example`, Secret Manager, the
`--set-secrets` list, and a **Secret Manager Secret Accessor** grant to the compute service account).
New non-secret `REMINDER_SWEEP_INTERVAL_MINUTES` (default 30); **keep the Cloud Scheduler cron
frequency equal to it**, or reminders drift late (cron slower than the look-ahead) or repeat (faster).

**Console setup (added to [README.md](../../README.md), UI-only per
[CLAUDE.local.md](../../CLAUDE.local.md)).**

- Secret Manager: create `REMINDER_SWEEP_SECRET` (and `REMINDER_SWEEP_SECRET_TEST`), grant the
  runtime compute service account **Secret Manager Secret Accessor** on each.
- Firestore -> Indexes: a composite index on collection group `reminders`, fields `status` (Asc) and
  `remindAt` (Asc). If skipped, the collection-group query fails with a Console link that creates
  exactly this index.
- Cloud Scheduler -> Create job: frequency `*/30 * * * *`, timezone `Europe/Kyiv`, target HTTP, URL
  the production function's `/sweep`, method POST, and a header `X-Sweep-Secret` carrying the
  `REMINDER_SWEEP_SECRET` value - the same shared-secret pattern the Telegram webhook uses.

## Invariants (must not break)

- The webhook still answers `200` for every handled update (including `callback_query`) and `401`
  only on a wrong webhook secret; `/sweep` answers `401` only on a wrong sweep secret. A Firestore or
  Telegram failure is caught and logged, never returned as `5xx` (no retry storms).
- The `ALLOWED_USERS` gate runs before any callback acts, and a reminder is only mutated by its own
  owner (`reminder.userId == from.id`).
- Double-notify is impossible: the `scheduled -> sent` flip happens inside a transaction, and the
  sweep query matches only `scheduled`.
- A snooze moves `remindAt` only; `eventAt` is immutable.
- Replies and deliveries set no `parse_mode`; buttons ride on `reply_markup`.
- Health-data discipline: never log `title`, `originalText`, or delivery text. Log the reminder id,
  the owner/chat id, and counts - the existing "ids and counts, not content" rule.
- Delivery must not resurrect an expired reminder: the 24h `expireAt` TTL from 0002 still applies.

## Acceptance criteria (locked)

Mirrored in the frontmatter `acceptance`. The verifier deploys the feature branch to the test
function (reflection on, `test` database), pins "now" per request with `X-Test-Now`, authenticates
`/sweep` with `TEST_SWEEP_SECRET`, drives capture + sweep + callbacks over HTTP, and asserts on
`/export` structure and the reflected deliveries - never on wording. Each criterion uses a distinct
`from.id` so reminders do not bleed between tests.

- **health / sweep-auth** - the function is up and the sweep endpoint is closed without the secret.
- **due-delivered** - a reminder 15 minutes ahead is delivered by the preceding tick and flipped to
  `sent` (the look-ahead, fire-early rule).
- **not-yet-due** - a reminder beyond the 30-minute window is left `scheduled`.
- **idempotent-no-double-send** - a repeated sweep does not re-deliver.
- **callback-ok-acks / callback-snooze-1h / callback-tomorrow** - each button moves the record as
  specified (`acked`; `remindAt = tap+1h`, re-scheduled; `remindAt = next day 09:00`, re-scheduled).
- **callback-not-owner** - a tap from a non-owner changes nothing.

Unit tests the implementer must add (deterministic, no network): the sweep cutoff (`now + interval`
selects a 15-min-ahead reminder and rejects a 75-min-ahead one); the `+1h` and "next day 09:00 local"
snooze math (including that DST offsets are applied by the timezone library); `callback_data`
parsing; and the owner-check refusal path.

## Out of scope

- **Recurrence** and **lead time** ("remind me an hour before"). `remindAt` stays equal to `eventAt`
  until a button moves it; the lead-time question and recurring reminders are later specs.
- **Quiet hours / night mode** (the user chose none).
- **A retry lease** for failed sends; v1 logs and moves on.
- **Editing or cancelling** a reminder beyond the three delivery buttons; no `/reminders` management
  UI, no free-text "cancel that".
- The **entries capture log**, embeddings, and the other intents - unchanged from 0002.
