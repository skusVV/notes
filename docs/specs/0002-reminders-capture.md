---
id: 0002-reminders-capture
state: DONE
attempt: 0
max_attempts: 3
branch: feat/0002-reminders-capture
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: auth-401
    assert: "POST any update with a wrong X-Telegram-Bot-Api-Secret-Token returns HTTP 401"
  - id: reminder-stored
    assert: "With header X-Test-Now=2026-09-16T09:00:00+03:00 (Wednesday, Europe/Kyiv), POST a message 'Remind me I have a haircut on Thursday at 12' from user id U1; then POST a '/export' command update from U1; the reflected reply (chunks concatenated) parses as JSON of shape {\"reminders\":[...]} containing exactly one item whose eventAt == '2026-09-17T12:00:00+03:00', whose title is a non-empty string, and whose originalText contains 'haircut'"
  - id: relative-next-week
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Remind me next Thursday at 18:00' from user id U2; a '/export' from U2 shows exactly one reminder with eventAt == '2026-09-24T18:00:00+03:00'"
  - id: absolute-day-of-month
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Remind me on the 25th at 12 to pay rent' from user id U3; a '/export' from U3 shows exactly one reminder with eventAt == '2026-09-25T12:00:00+03:00'"
  - id: missing-time-not-stored
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Remind me on Thursday to call the doctor' (no time of day) from user id U4; a '/export' from U4 returns {\"reminders\":[]}"
  - id: expireAt-present
    assert: "The reminder stored under reminder-stored has an expireAt field that parses as a timestamp and is >= its eventAt instant"
  - id: export-empty-shape
    assert: "A '/export' command update from a user id with no reminders (U5) returns a reflected reply that parses as JSON exactly equal to {\"reminders\":[]}"
  - id: non-reminder-not-stored
    assert: "POST 'Just thinking about the roof' from user id U6; a '/export' from U6 returns {\"reminders\":[]}"
failures:
  - attempt: 0
    stage: in-testing
    detail: >-
      Storage is non-functional on the test deploy. Every reminder reply was "I could not store this
      reminder right now." and every /export returned {"reminders":[]}, so reminder-stored,
      relative-next-week, absolute-day-of-month and expireAt-present could not be observed, and
      missing-time-not-stored is masked (empty for the wrong reason). The classifier resolved dates
      correctly (haircut->2026-09-17T12:00:00+03:00, next Thursday->2026-09-24T18:00:00+03:00, the
      25th->2026-09-25T12:00:00+03:00), so GCP_PROJECT is set and the model path works; the failure
      is the Firestore backend. Most likely the spec's required Firestore Console/IAM setup for the
      test function is not provisioned (create the `test` Native database in europe-west1, grant the
      runtime compute service account roles/datastore.user, add the reminders TTL policy) - the agent
      cannot create it (no gcloud, no Console). BLOCKED pending that setup; if it is already in place,
      escalate to the implementer to investigate the Firestore error in Cloud Logging. Secondary
      finding to re-check once storage works: the missing-time case ("call the doctor" with no time)
      had the model fabricate 09:00 and the code took the store path, so the invent-nothing invariant
      may be violated (likely a NEEDS-REWORK for the classifier/prompt). Security checklist: PASS.
---

# 0002 - Reminders: capture, resolve, store

## Context

Turn a spoken or typed reminder into a stored record. Today the `reminder` branch only composes a
reply and stores nothing (see the `NOT_STORED_NOTICE` on every classified reply). This spec makes the
bot **remember** reminders: the classifier recognises the reminder, resolves the relative date and
time it names into a concrete instant, and the reminder is written to Firestore.

This is the first persistence in the project - "phase 0" of [../architecture.md](../architecture.md)
(sections 5, 6, 8), scoped down to the one projection the user asked for. It deliberately does **not**
deliver reminders (no Cloud Scheduler sweeper, no inline keyboards, no lead-time question). Capture
and readback only, so the whole slice is verifiable over HTTP.

The one gap that makes relative dates work: the classifier is given a **timezone** today but never the
**current date/time**, so it cannot know that "Thursday" is tomorrow. This spec supplies "now" to the
classifier. `ReminderDraft.eventAt` is already typed as *"ISO 8601 with offset, resolved from relative
speech using the user's timezone"* ([classifier.types.ts:22-29](../../src/classifier/classifier.types.ts#L22-L29)),
so the model does the resolution and code validates and normalises the result.

## Scope

The implementer may touch only these:

- `src/clock/` (new) - `ClockService`: the single source of "now". Returns the current instant and a
  formatted local-time string for a given IANA timezone. Accepts an optional override string used
  only for tests (see Contracts). This is the "current date/time tool" the feature needs.
- `src/firestore/` (new) - a thin Firestore client provider. Reads `GCP_PROJECT` and the already-wired
  `FIRESTORE_DATABASE` env var; exposes an `available` flag and degrades (does not throw on
  construction) when `GCP_PROJECT` is unset, mirroring `TranscriptionService` and `ClassifierService`.
- `src/reminders/` (new) - `RemindersService.create(...)` and `RemindersService.list(userId)`, backed
  by Firestore at `users/{userId}/reminders/{autoId}`.
- `src/classifier/classifier.types.ts` - add `now` to `ClassifierContext`. (`ReminderDraft.eventAt`
  already exists; do not change its shape.)
- `src/classifier/classifier.service.ts` - put the current local time into the prompt; tighten the
  reminder-payload validation so a reminder with no resolvable future `eventAt` is forced below
  `CONFIDENCE_ASK` (the existing "invalid payload -> ask, do not invent" rule).
- `src/telegram/telegram.service.ts` - assemble `ClassifierContext.now`; make the `reminder` branch
  persist via `RemindersService` and confirm the **resolved** time; add the `/export` command in
  `handleCommand`; make `NOT_STORED_NOTICE` conditional (see Invariants).
- `src/telegram/telegram.controller.ts` - when `TEST_REFLECT_REPLY` is on, read the `X-Test-Now`
  header and pass it down as the clock override for that request (same test-only plumbing as `sink`).
- `src/telegram/telegram.module.ts`, `src/app.module.ts` - wire the new modules.
- `package.json` - add `@google-cloud/firestore` and a timezone-aware date library (`luxon` +
  `@types/luxon`).
- `.env.example`, `README.md` - document `FIRESTORE_DATABASE` (now read by code), the new Console
  setup, and that `X-Test-Now` is test-only.
- `test/` - unit tests for the deterministic pieces (see Acceptance).

Out of bounds without returning to `DRAFT`: `cloudbuild.yaml` (the env vars this needs are already
wired), the transcription service, the webhook response contract, and any delivery/scheduler code.

## Contracts

**`ClockService`.**
- `now(overrideIso?: string): Date` - the current instant, or `overrideIso` parsed, when that string
  is a valid ISO 8601 with offset. An invalid or absent override falls through to the real clock.
- A helper that formats an instant as a local-time ISO string with offset for a given IANA timezone,
  e.g. `2026-09-16T09:00:00+03:00`, for the classifier prompt.

**`X-Test-Now` header (test-only).** ISO 8601 with offset. Honored **only** when `TEST_REFLECT_REPLY`
is `true` (i.e. the test function); it sets the clock's "now" for that one request. Production has
`TEST_REFLECT_REPLY=false`, so the header is ignored there entirely - the same trust boundary as reply
reflection.

**`ClassifierContext.now: string`.** Required. Current local time as ISO 8601 with offset, in the
user's timezone. The classify prompt states it and the resolution rules below.

**Date-resolution rules (prompt-level, so the model is consistent).**
- Resolve every relative date against `now`. `eventAt` is emitted **only** when both a specific date
  and a specific time of day are determinable; if either is unclear, leave `eventAt` absent.
- A bare weekday ("Thursday") means its next occurrence strictly after `now`.
- "next {weekday}" means the occurrence in the following week, not tomorrow.
- "the Nth" means the next occurrence of that day-of-month that is not before today.
- `eventAt` is ISO 8601 with the user's local offset.

**`RemindersService.create(userId, { title, eventAt }, originalText, now)`.**
- Validates and **normalises** `eventAt` with the timezone-aware library to the canonical format
  `YYYY-MM-DDThh:mm:ss` + offset (seconds precision, no milliseconds), e.g.
  `2026-09-17T12:00:00+03:00`. An `eventAt` that is missing, unparseable, or not after `now` is
  rejected (no write) - the caller then treats the reminder as unresolved.
- Writes a document to `users/{userId}/reminders/{autoId}` with: `userId` and `chatId` (the Telegram
  sender and chat, so delivery in spec 0003 knows where to send), `originalText` (the message
  verbatim), `title` (the paraphrased one-liner), `eventAt` (canonical string above), `eventAtUtc`
  (Firestore `Timestamp`), `remindAt` (`Timestamp`, initialised equal to `eventAtUtc`; the instant
  delivery compares against, kept separate so a later snooze can move the notification without moving
  the event), `createdAt` (`Timestamp`, from `now`), `expireAt` (`Timestamp` = `eventAt` + 24h; the
  field the TTL policy targets), and `status: 'scheduled'`.

**`RemindersService.list(userId)`.** Returns that user's reminders ordered by `eventAt` ascending.

**`/export` command** (routed in `handleCommand`, before classification, like `/version`). Replies
with a single JSON object `{"reminders": [ { id, originalText, title, eventAt, remindAt, createdAt,
expireAt, status }, ... ]}` for the **requesting** user only (`from.id`). `remindAt` is emitted in
the same canonical local-ISO-with-offset form as `eventAt`; the other `Timestamp` fields are
serialised as ISO strings, and `id` is the Firestore document id. No `parse_mode`. Long output goes through the existing 4096-char chunking; a reader
concatenates chunks before parsing.

**Env / config.** No new env var. `FIRESTORE_DATABASE` is already set by
[cloudbuild.yaml](../../cloudbuild.yaml) (`(default)` in prod, `test` in the test function) and must
now be read when constructing the Firestore client. `DEFAULT_TIMEZONE` already exists.

**Console setup (added to [README.md](../../README.md), UI-only per
[CLAUDE.local.md](../../CLAUDE.local.md)).** Create a Firestore **Native** database in
`europe-west1` (this location is permanent) for production and a second database named `test`; grant
the function's runtime compute service account **Cloud Datastore User** (`roles/datastore.user`); add
a **Time-to-live** policy on collection group `reminders`, field `expireAt`, on both databases.

## Invariants (must not break)

- The webhook still answers `200` for every handled update and `401` only on a wrong secret token;
  a Firestore failure is caught and logged, never returned as `5xx`.
- The `ALLOWED_USERS` gate runs before the classifier and before any Firestore write.
- Commands (`text.startsWith('/')`) are routed before the model; `/export` joins them.
- Replies set no `parse_mode` (the JSON export and user words must survive a stray underscore).
- Reminder-payload validation never **invents** a missing field. A reminder with no resolvable time
  is pushed below `CONFIDENCE_ASK` and handled by the existing clarify branch - not stored with a
  guessed time.
- `NOT_STORED_NOTICE` becomes conditional: a reply that **did** store a reminder must not carry it,
  and must not falsely claim a store it did not make. Non-reminder intents (still unpersisted) keep
  the notice. Its wording is updated so it no longer claims *"nothing is stored"* wholesale.
- Health-data discipline: never log `originalText`, `title`, `eventAt`, or `/export` output. Keep the
  existing "log ids and counts, not content" rule.
- `RemindersService` and the Firestore provider must not throw on construction when `GCP_PROJECT` is
  unset; they degrade and the reminder branch replies that it could not store, so text handling
  survives - the same pattern as transcription and classification.

## Acceptance criteria (locked)

Mirrored in the frontmatter `acceptance`. The verifier drives the test function (reply reflection on,
`test` Firestore database) and asserts on stored structure read back via `/export`, never on reply
wording. Each criterion uses a distinct `from.id` so stored reminders do not bleed between tests.
"Now" is pinned per request with `X-Test-Now: 2026-09-16T09:00:00+03:00` (a Wednesday in
`Europe/Kyiv`).

- **health / auth-401** - carried over, prove the function and auth path on the test deploy.
- **reminder-stored** - "haircut on Thursday at 12" resolves to `2026-09-17T12:00:00+03:00`, stored
  with a non-empty title and the original words.
- **relative-next-week** - "next Thursday at 18:00" resolves to `2026-09-24T18:00:00+03:00` (proves
  "next" is the following week, not tomorrow).
- **absolute-day-of-month** - "the 25th at 12" resolves to `2026-09-25T12:00:00+03:00`.
- **missing-time-not-stored** - a reminder naming a day but no time is **not** stored (the
  invent-nothing rule).
- **expireAt-present** - the TTL field is written and is at or after `eventAt`.
- **export-empty-shape** - `/export` with no data returns exactly `{"reminders":[]}`.
- **non-reminder-not-stored** - a plain note writes no reminder.

Unit tests the implementer must add (deterministic, no network): `eventAt` normalisation and
rejection (valid ISO in various precisions -> canonical; missing/past/garbage -> rejected);
`expireAt` = `eventAt` + 24h; the `ClockService` override formatting; the reminder-validation path
that forces confidence below `CONFIDENCE_ASK`.

## Out of scope

- **Delivery.** No Cloud Scheduler sweeper, no "your reminder is due" message, no `remindAt`/
  `leadMinutes`/snooze. `status` is written as `scheduled` and never advances yet.
- **Asking for a missing time.** Inline keyboards and the `pending` state machine are a later spec; a
  reminder with no clear time is simply not stored here.
- **The full entries capture log.** This slice stores only the `reminders` projection (with the
  original words on it). The immutable `entries` log keyed on `update_id`, embeddings, and the other
  intents' projections come later. `correction`, `question`, `symptom`, `actor_info` are unchanged.
- **Per-user timezone.** One global `DEFAULT_TIMEZONE` for now; the per-user `timezone` field is
  deferred.
- **Recurrence.** `recurrence` stays absent; recurring reminders are a later spec.
