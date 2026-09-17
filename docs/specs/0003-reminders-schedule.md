---
id: 0003-reminders-schedule
state: DRAFT
attempt: 0
max_attempts: 3
branch: feat/0003-reminders-schedule
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: auth-401
    assert: "POST any update with a wrong X-Telegram-Bot-Api-Secret-Token returns HTTP 401"
  - id: yearly-birthday-recurring
    assert: "With header X-Test-Now=2026-09-16T09:00:00+03:00 (Wednesday, Europe/Kyiv), POST 'День народження Олександра 2 листопада' from user id U20; then POST '/export' from U20; the reflected reply parses as JSON {\"reminders\":[...]} containing exactly one item whose recurrence == {\"freq\":\"yearly\",\"interval\":1}, whose eventAt == '2026-11-02T07:00:00+02:00' (note the +02:00 offset - Kyiv is past the October DST transition by then), whose remindAts is an array of exactly one item with at == '2026-11-02T07:00:00+02:00' and status == 'scheduled', and whose JSON object has no expireAt key at all"
  - id: weekly-recurring
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Нагадуй мені щопонеділка о 9:00 виносити сміття' from user id U21; a '/export' from U21 shows exactly one reminder with recurrence == {\"freq\":\"weekly\",\"interval\":1}, eventAt == '2026-09-21T09:00:00+03:00', and remindAts an array of exactly one item whose at equals eventAt"
  - id: daily-recurring
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Нагадуй мені щодня о 8:00 випити ліки' from user id U22; a '/export' from U22 shows exactly one reminder with recurrence == {\"freq\":\"daily\",\"interval\":1} and eventAt == '2026-09-17T08:00:00+03:00' (today's 08:00 already passed relative to now, so the first occurrence is tomorrow)"
  - id: monthly-recurring
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Нагадуй мені 5 числа кожного місяця о 10:00 оплатити інтернет' from user id U23; a '/export' from U23 shows exactly one reminder with recurrence == {\"freq\":\"monthly\",\"interval\":1} and eventAt == '2026-10-05T10:00:00+03:00' (this month's 5th already passed)"
  - id: multi-remind-times
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Завтра о 10:00 зустріч з лікарем, нагадай мені двічі: вранці і за годину' from user id U24; a '/export' from U24 shows exactly one reminder with eventAt == '2026-09-17T10:00:00+03:00', recurrence == null, and remindAts an array of exactly two items whose at values are the set {'2026-09-17T07:00:00+03:00', '2026-09-17T09:00:00+03:00'} (order not asserted), each with status == 'scheduled'"
  - id: default-single-remind
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Нагадай мені завтра о 15:00 зателефонувати в банк' from user id U25 (no recurrence, no remind-time request); a '/export' from U25 shows exactly one reminder whose remindAts is an array of exactly one item whose at equals eventAt ('2026-09-17T15:00:00+03:00')"
  - id: missing-time-still-rejected
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Нагадай мені в четвер зателефонувати лікарю' (a date, no clock time, no recurrence cue) from user id U26; a '/export' from U26 returns {\"reminders\":[]} - the 0002 invent-nothing rule for one-off reminders is unchanged"
  - id: export-empty-shape
    assert: "A '/export' command update from a user id with no reminders (U27) returns a reflected reply that parses as JSON exactly equal to {\"reminders\":[]}"
  - id: multi-intent-reminder-preserved
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Голова болить, нагадай випити таблетку о 18:00' (a symptom description plus a same-message reminder) from user id U28; a '/export' from U28 shows exactly one reminder whose originalText contains 'таблетку', eventAt == '2026-09-16T18:00:00+03:00', recurrence == null, and remindAts an array of exactly one item whose at equals eventAt - the symptom mention does not block, corrupt, or duplicate reminder capture"
failures: []
---

# 0003 - Reminders: recurrence and multiple remind times

## Context

[0002-reminders-capture.md](0002-reminders-capture.md) stores exactly one `eventAt` and one
`remindAt` per reminder, and explicitly defers two things: "`recurrence` stays absent; recurring
reminders are a later spec" ([0002-reminders-capture.md:209](0002-reminders-capture.md#L209)). This
is that later spec, plus a second, related gap: a reminder can only ever produce one notification
instant, when in practice "remind me twice, in the morning and an hour before" is a normal ask.

Both gaps live in the same place - the classifier's `reminder` payload and
[reminders.service.ts](../../src/reminders/reminders.service.ts) - and don't have a clean boundary
between them (a recurring birthday can also want two remind times), so this is one spec, not two.
See [architecture.md:508-510](../architecture.md#L508-L510) for the standing decision this builds
on: recurring reminders are stored as local wall-clock time plus timezone, resolved fresh each
occurrence, specifically so a daylight-saving transition does not silently shift the fire time by an
hour twice a year.

Like 0002, this spec is capture-only: nothing here delivers a reminder. It stores a richer shape so
delivery only needs to be designed once, against the real schema. Delivery's own design (30-minute
cron, look-ahead sweep - "fire early, not late") was already settled in conversation before this
schema existed, under the working number "spec 0003"; that work is renumbered to **spec 0004** by
this file existing. [reminders.service.ts:73](../../src/reminders/reminders.service.ts#L73) has a
comment naming "spec 0003" as delivery - fix it to name 0004 while this file is being implemented.

This spec cannot be implemented ahead of 0002: it extends `RemindersService.create` and the
`reminders` document shape 0002 defines. Per current git status, 0002 is `IN-TESTING`/blocked on
Firestore provisioning for the test deploy - this file may be drafted now, but should not move to
`READY` for an implementer to claim until 0002 reaches at least `IMPLEMENTED` on `main` (or this
branch is rebased on it).

**Multi-intent messages ("Голова болить, нагадай випити таблетку о 18:00" is a symptom AND a
reminder) are not a new decision here.** [architecture.md:126-129](../architecture.md#L126-L129)
already settled "array, not dominant intent" as the design, and the classifier already implements
it: `RESPONSE_SCHEMA.items` is an array with an explicit "Never merge them" description, the prompt
already says "Return one item per intent present, not one item per message"
([classifier.service.ts:282](../../src/classifier/classifier.service.ts#L282)), and
`TelegramService.route` already loops over every item and handles each on its own
([telegram.service.ts:413](../../src/telegram/telegram.service.ts#L413)) - a reminder item is
persisted, a symptom item still only composes a reply (symptom persistence does not exist yet, see
Out of scope). Nothing about this needs re-deciding. What is missing is a **test** proving it: no
spec has ever locked an acceptance criterion over a combined message, and this spec rewrites the
exact reminder prompt/schema a regression would hide in - so one criterion is added below
(`multi-intent-reminder-preserved`) to guard that a symptom mentioned in the same message never
blocks, corrupts, or duplicates the reminder half. It does not attempt to assert anything about the
symptom half, because there is no stored structure for a symptom to read back yet.

A separate idea surfaced in the same conversation - a symptom's `startedAt` defaulting to the
current time when the message describes it in the present tense ("голова болить" = happening now) -
is real but belongs to symptom capture (architecture.md phase 3), which has no spec yet at all: no
`SymptomsService`, no persistence, [describeSymptom](../../src/telegram/telegram.service.ts#L548)
still only composes a reply. It is out of bounds for this file (see Scope) and is recorded in memory
for whoever writes that spec, rather than decided here.

## Scope

- [src/classifier/classifier.types.ts](../../src/classifier/classifier.types.ts) - replace the
  unused placeholder fields `ReminderDraft.leadMinutes` and `ReminderDraft.recurrence: string`
  (present since 0002, never wired to anything) with:
  - `RecurrenceRule { freq: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval: number }`
  - `RemindTimeDraft { beforeMinutes?: number; atLocalTime?: string }` - exactly one of the two
    keys, or neither (see Contracts, default anchor time)
  - `ReminderDraft.recurrence?: RecurrenceRule`
  - `ReminderDraft.remindTimes?: RemindTimeDraft[]`
- [src/classifier/classifier.service.ts](../../src/classifier/classifier.service.ts) - extend
  `RESPONSE_SCHEMA.items[].reminder` with `recurrence`, `remindTimes`, and a model-facing
  `eventDate` (date-only, used only alongside `recurrence` when no clock time is stated); extend the
  date-resolution prompt rules (see Contracts); extend `coerceItem`'s defensive parsing to build and
  clamp `recurrence`/`remindTimes` the same way `symptom`/`question` are already clamped, and to feed
  the new default-anchor-time construction into the existing `reminderUnresolved` check.
- [src/reminders/event-at.ts](../../src/reminders/event-at.ts) - add: a helper that combines a
  date-only string with the default anchor time-of-day and a timezone into a canonical `eventAt`
  (reusing `normalizeEventAt` for the final validation); a helper that resolves one `RemindTimeDraft`
  against a resolved `eventAt` into a concrete instant, applying the same default when both of its
  fields are absent.
- [src/reminders/reminders.service.ts](../../src/reminders/reminders.service.ts) - extend
  `ReminderDraftInput`/`create()` to accept `recurrence` and `remindTimes`; compute `remindAts[]` and
  the derived `nextRemindAt`; write `expireAt` only when `recurrence` is absent; update
  `ReminderExport`/`toExport()` for the new shape; fix the "spec 0003" comment noted above.
- [src/telegram/telegram.service.ts](../../src/telegram/telegram.service.ts) - pass
  `recurrence`/`remindTimes` through to `RemindersService.create`. The `/export` command itself is
  unchanged (the shape change lives in `RemindersService`).
- `test/` - unit tests for the deterministic pieces (see Acceptance).

Out of bounds without returning to `DRAFT`: any Cloud Scheduler / sweeper code, `remindAts[].status`
transitions beyond the initial `'scheduled'`, recurrence roll-forward after a reminder fires, a
cancel/skip-one-occurrence command, `cloudbuild.yaml`, and the other intents (`symptom`, `question`,
`actor_info`, `correction`, `note`).

## Contracts

**`RecurrenceRule`.** `freq` is one of the four values above; an unrecognised value drops the whole
`recurrence` (treated as absent), the same defensive style `coerceItem` already uses for an unknown
top-level `intent`. `interval` defaults to, and is clamped to a minimum of, `1`.

**Recurrence detection (prompt-level).**
- An explicit cadence word ("every day/week/month/year", "щодня/щотижня/щомісяця/щороку", plus an
  interval like "every 2 weeks") sets `recurrence` accordingly.
- A birthday or anniversary mention implies `recurrence: {freq: 'yearly'}` even with no explicit
  cadence word - "Олександра день народження 2 листопада" is recurring by what it is, not by wording.
- Nothing else infers recurrence. A plain "remind me Thursday at 12" stays one-off.
- Multi-weekday patterns ("every Mon/Wed/Fri") and any interval finer than the four `freq` values are
  out of scope - the model should pick the closest single `freq` or, if none fits, omit `recurrence`
  and let the reminder fall back to one-off handling.

**Default anchor time - the one exception to 0002's invent-nothing rule for `eventAt`.**
0002 requires both a specific date **and** an explicit clock time before it will emit or store
`eventAt`; a date with no time is rejected outright
([0002-reminders-capture.md:187](0002-reminders-capture.md#L187),
[classifier.service.ts:264-277](../../src/classifier/classifier.service.ts#L264-L277)). That rule is
unchanged for a one-off reminder with no recurrence and no remind-time request (see
`missing-time-still-rejected`). It gets exactly one carve-out:

- When the message resolves to a **recurring** reminder and states a date but no clock time, the
  model emits `eventDate` (`YYYY-MM-DD`, the next occurrence's date) instead of `eventAt`, still with
  `hasTimeOfDay: false` (that stays a true statement about what the user said). Code, not the model,
  then builds the canonical `eventAt` from `eventDate` + the fixed default anchor time **07:00**
  local + the user's timezone, and treats it as resolved from there (normalised the same way any
  other `eventAt` is). The model never invents the hour; a named constant in code does, exactly once,
  in one place.
- The same constant (07:00) resolves a `remindTimes` entry that has neither `beforeMinutes` nor
  `atLocalTime` set - the vague-time-of-day case ("вранці" with no stated hour). No other day-part
  words ("afternoon", "evening") get a default in this spec; an entry the model cannot resolve at all
  falls back to this one constant rather than a set of guessed hours for words nobody asked for yet.

**`RemindTimeDraft` resolution.**
- `beforeMinutes: N` -> `eventAt` minus `N` minutes.
- `atLocalTime: 'HH:mm'` -> that clock time on `eventAt`'s calendar day, in the user's timezone.
- Neither set -> the default anchor time above, on `eventAt`'s calendar day.
- When the classifier returns **no** `remindTimes` at all, code synthesizes exactly one entry
  equivalent to `beforeMinutes: 0` (fires at the event instant) - this is 0002's original behavior,
  preserved as the fallback, not layered on top of an explicit list. When the classifier **does**
  return one or more entries, those are used as-is; the event-instant entry is not added on top of an
  explicit list ("remind me twice" means two, not three).

**`RemindersService.create(userId, { title, eventAt, recurrence?, remindTimes? }, originalText, now)`.**
- `eventAt`/`recurrence` validated and normalised as above; an unresolved `eventAt` still means no
  write, same as 0002.
- Writes, in addition to 0002's existing fields:
  - `recurrence: { freq, interval }` when present; the key is **omitted entirely** when the reminder
    is one-off (not `null` - Firestore's TTL policy already skips documents missing the targeted
    field, so an absent `expireAt` on a recurring document needs no policy change; treating
    `recurrence` the same way keeps one convention for "not applicable" across this document).
  - `remindAts`: array of `{ at: Timestamp, status: 'scheduled' }`, one entry per resolved remind
    time (minimum one). Replaces 0002's singular `remindAt`.
  - `nextRemindAt`: `Timestamp`, the earliest `at` among `remindAts`. Derived purely so a future
    sweeper can run a plain `where('nextRemindAt', '<=', cutoff)` range query instead of ranging
    inside an array - the same kind of derived equality/range helper field as `ym` on entries
    ([architecture.md:355-357](../architecture.md#L355-L357)). Not exposed via `/export`.
  - `expireAt`: written exactly as 0002 (`eventAt` + 24h) **only when `recurrence` is absent**.
    Omitted entirely for a recurring reminder, so it never expires - Firestore's TTL sweep does
    nothing to a document with no value in the targeted field.
- Top-level `status` is unchanged (`'scheduled'`, written once, not yet advanced by anything - still
  no delivery in this spec).

**`/export` shape update.** Each reminder object gains `recurrence` (the object above, or `null` for
a one-off reminder) and `remindAts` (array of `{ at, status }`, `at` in the same local-ISO-with-offset
form 0002 used for the old `remindAt`) **replacing** the old singular `remindAt` field. `expireAt` is
present for a one-off reminder and **absent as a key** for a recurring one (not `null`) - the
`yearly-birthday-recurring` criterion asserts this directly. Everything else in the export shape
(`id`, `originalText`, `title`, `eventAt`, `createdAt`, `status`) is unchanged from 0002.

## Invariants (must not break)

- Everything 0002 already locked: the `200`/`401` webhook contract, the `ALLOWED_USERS` gate before
  any model call or write, commands routed before classification, no `parse_mode` on replies, health-
  data discipline (never log reminder content, only ids/counts), and `RemindersService`/the Firestore
  provider never throwing on construction when `GCP_PROJECT` is unset.
- **A one-off reminder with no clock time and no recurrence/remind-time cue is still not stored.**
  The only new leniency is the single, explicit carve-out above for recurring reminders; it must not
  widen to cover plain one-off reminders (`missing-time-still-rejected` guards this).
- **A recurring reminder never carries `expireAt`.** "Never expires" means the TTL field is absent,
  not far in the future.
- **`remindTimes` never invents an entry the user did not ask for beyond the one implicit default.**
  A plain reminder still produces exactly one `remindAts` item equal to `eventAt`
  (`default-single-remind` guards this); an explicit list is used as given, never padded.
- The default anchor time (07:00) is a single named constant used in exactly the two places
  described above - not a per-day-part table, and not model-invented.
- **Multi-intent splitting is not weakened by the schema/prompt changes here.** A message carrying a
  symptom (or any other intent) alongside a reminder must still produce a separate item per intent
  (`multi-intent-reminder-preserved` guards the reminder half of this).

## Acceptance criteria (locked)

Mirrored in the frontmatter `acceptance`. Same verification method as 0002: drive the test function
with `X-Test-Now` pinned, read stored structure back via `/export`, never assert on reply wording.
Each criterion uses a distinct `from.id`.

- **health / auth-401** - carried over, prove the function and auth path on the test deploy.
- **yearly-birthday-recurring** - a birthday with no stated time infers `yearly` recurrence and the
  07:00 default anchor time, resolved with the correct **winter** UTC+2 offset for a November date
  even though "now" is pinned in summer (+3), and carries no `expireAt`.
- **weekly-recurring** / **daily-recurring** / **monthly-recurring** - the other three `freq` values,
  each with an explicit time, each resolving to the correct next occurrence from the pinned "now".
- **multi-remind-times** - "twice: in the morning and an hour before" produces exactly two
  `remindAts` entries at the expected instants, not three.
- **default-single-remind** - a plain reminder with no schedule request still produces exactly one
  `remindAts` entry equal to `eventAt` (0002's original behavior, unchanged).
- **missing-time-still-rejected** - a date with no time and no recurrence/remind-time cue is still
  not stored (0002's invariant, unchanged).
- **export-empty-shape** - carried over.
- **multi-intent-reminder-preserved** - a symptom description in the same message as a reminder does
  not stop the reminder from being classified and stored (regression guard: multi-intent splitting
  is pre-existing behavior this spec's prompt/schema changes must not weaken; see Context).

Unit tests the implementer must add (deterministic, no network): `recurrence` clamping (bad `freq`
dropped, `interval` clamped to >=1); `remindTimes` entry validation (exactly one of the two keys
kept, malformed entries dropped, not the whole array); the date-only + recurrence -> default-anchor-
time `eventAt` construction; per-`freq` next-occurrence date math for all four values, including the
Kyiv DST boundary (a date after the last Sunday of October resolves at `+02:00`, one before it at
`+03:00`); `nextRemindAt` = earliest `remindAts[].at`; `expireAt` present vs omitted.

## Out of scope

- **Delivery.** No sweeper, no "your reminder is due" message, no `remindAts[].status` ever advancing
  past `'scheduled'`. This is spec 0004 (renumbered from the earlier working name "0003" - see
  Context), already designed as a 30-minute cron with a look-ahead sweep.
- **Recurrence roll-forward.** After a recurring reminder's occurrence passes, nothing here advances
  `eventAt`/`remindAts` to the next cycle - that only matters once delivery exists to observe a fired
  occurrence, so it belongs with spec 0004.
- **Editing or cancelling a reminder, in whole or "just this once."** No chat command exists for this
  yet (0002 didn't have one either). The schema here - a recurrence rule stored apart from the
  currently-resolved next occurrence - is exactly what will let a future "skip this one" operation
  roll `eventAt`/`remindAts` forward without touching `recurrence`, but building that operation is not
  this spec's job.
- **Multi-weekday and other RRULE-style patterns.** Exactly the four `freq` values, each with a
  single `interval`; no per-weekday lists, no "last Friday of the month", no formal recurrence-rule
  library.
- **Extra default times for other vague day-parts.** Only "no time stated at all" defaults, to 07:00.
  "Afternoon", "evening", etc. are not given defaults in this spec.
- **Per-user timezone, the full `entries` capture log, and the other intents.** Unchanged from 0002.
- **Symptom capture itself, including defaulting `startedAt` to the current time for a present-tense
  symptom.** No `SymptomsService` exists; `describeSymptom` still only composes a reply. This is
  phase-3 (symptoms) material for a future spec, not this one - recorded in memory so it is not lost.
