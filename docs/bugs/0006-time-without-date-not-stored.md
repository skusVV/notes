---
id: 0006-time-without-date-not-stored
state: IN-TESTING
severity: medium
attempt: 0
max_attempts: 3
branch: fix/0006-time-without-date-not-stored
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: repro-fixed
    assert: "With X-Test-Now=2026-11-25T06:10:00+02:00, from user 900000001 POST 'Нагадай мені о пів на восьму вигуляти собаку'; '/export' from 900000001 shows exactly one reminder whose eventAt == 2026-11-25T07:30:00+02:00"
  - id: bare-hour
    assert: "With X-Test-Now=2026-11-25T06:10:00+02:00, from user 900000002 POST 'Нагадай мені о 5 зустрітись з дружиною'; '/export' from 900000002 shows exactly one reminder whose eventAt == 2026-11-25T17:00:00+02:00"
  - id: today-not-tomorrow
    assert: "With X-Test-Now=2026-11-25T06:10:00+02:00, from user 900000003 POST 'Нагадай о дев’ятій ранку взяти документи на роботу'; '/export' from 900000003 shows exactly one reminder whose eventAt == 2026-11-25T09:00:00+02:00"
  - id: passed-time-rolls-over
    assert: "With X-Test-Now=2026-11-25T06:10:00+02:00, from user 900000004 POST 'Нагадай мені о 6 ранку випити вітаміни'; '/export' from 900000004 shows exactly one reminder whose eventAt == 2026-11-26T06:00:00+02:00"
  - id: dated-unchanged
    assert: "With X-Test-Now=2026-11-25T06:10:00+02:00, from user 900000005 POST 'Нагадай в п’ятницю о 8 вечора про вечерю'; '/export' from 900000005 shows exactly one reminder whose eventAt == 2026-11-27T20:00:00+02:00"
  - id: no-time-still-asks
    assert: "With X-Test-Now=2026-11-25T06:10:00+02:00, from user 900000006 POST 'Нагадай мені в четвер подзвонити лікарю'; '/export' from 900000006 shows no reminder (the bot asks for the time instead of storing one)"
  - id: unit-regression
    assert: "npm test passes and includes regression tests, failing on the pre-fix code, for a canned model reply {hasTimeOfDay: true, dateStated: false, atLocal: '07:30', no eventAt} at now=06:10 Europe/Kyiv resolving to today 07:30 with confidence kept, and atLocal '06:00' resolving to tomorrow 06:00"
failures: []
---

# BUG-0006 - A reminder with a clock time but no day is not stored

> **READY 2026-11-25** (owner: "можеш робити фікс без мене"). Found in prod logs the same morning:
> two voice reminders from the owner at 04:09 and 04:10 UTC both logged
> `Classifier returned reminder without a usable payload` and `[reminder 0.49]`, so the bot asked
> instead of storing. Transcripts are not logged, so the exact words are unknown; the cause below
> was reproduced against the real model (gemini-3.5-flash-lite, Vertex) with typical phrasings.

## Symptom

"Нагадай мені о пів на восьму вигуляти собаку" or "Нагадай мені о 5 зустрітись з дружиною": the
bot does not create the reminder, it answers as if unsure (confidence 0.49). "Нагадай о дев'ятій
ранку …" sent at 06:10 is stored for **tomorrow** 09:00 instead of today.

## Reproduction

Real classifier, now = 2026-11-25T06:10:00+02:00 (Europe/Kyiv):

| Message | Today's result |
|---|---|
| Нагадай мені о пів на восьму вигуляти собаку | no eventAt, `leadMinutes: 30` invented -> 0.49 |
| Нагадай мені о 5 зустрітись з дружиною | no eventAt -> 0.49 |
| Нагадай о дев’ятій ранку взяти документи на роботу | eventAt 2026-11-**26**T09:00 (should be today) |
| Нагадай мені о 19:00 купити хліб | 2026-11-25T19:00 (works, inconsistently) |

## Root cause

[classifier.service.ts](../../src/classifier/classifier.service.ts): the prompt and the `eventAt`
schema description say "Emit eventAt ONLY when the message gives BOTH a specific date AND an
explicit clock time". A time with no day therefore often gets no `eventAt`, and `coerceItem` then
treats the reminder as unresolved (`!normalizeEventAt(...)`) and forces confidence to
`CONFIDENCE_ASK - 0.01` = 0.49. When the model does emit one, it does the today/tomorrow arithmetic
itself and gets it wrong.

## Fix

Move the date arithmetic for the time-only case into code. A prototype of exactly this was run
against the real model and returned the correct instant for all the rows above plus the
dated/undated neighbours:

- Reminder schema gets two fields: `atLocal` (the stated clock time, `"HH:mm"` 24-hour, omitted
  when none was stated) and `dateStated` (boolean: true when the message names the day in any form,
  false when it gives only a clock time). Add both to `propertyOrdering` after `hasTimeOfDay`.
- In `coerceItem`, for a non-recurring reminder with `hasTimeOfDay === true`,
  `dateStated === false` and a valid `atLocal` (via `normalizeAtLocal`, exported from
  [recurrence.ts](../../src/reminders/recurrence.ts)), set
  `eventAt = nextOccurrenceAfter({ freq: 'daily', atLocal, timezone }, now)` - overriding whatever
  the model put in `eventAt`. Only an explicit `false` counts; absent is not a "no".
- Prompt: a clock time with no date is a full time (next occurrence strictly after now); an hour
  1-12 with no part-of-day word is whichever of H:00 / (H+12):00 comes first after now; Ukrainian
  "пів на N" = (N-1):30 and "чверть на N" = (N-1):15 are clock times, never `leadMinutes`. The
  "BOTH a date AND a time" wording becomes "an explicit time of day".

## Fix scope

- `src/classifier/classifier.service.ts`
- `src/reminders/recurrence.ts` (export `normalizeAtLocal` only)
- `test/classifier.reminder.spec.ts` (regression tests)

## Invariants (must not break)

- Invent-nothing: no clock time stated -> no eventAt -> clarify (`no-time-still-asks`). The
  current local time is never used as a time.
- `hasTimeOfDay` stays the code-enforced gate; `dateStated` only decides who does the arithmetic.
- Recurring reminders are untouched (the override is skipped when a recurrence is present).
- Classifier never throws on a malformed reply.

## Acceptance criteria (locked at READY)

See front matter: **repro-fixed**, **bare-hour**, **today-not-tomorrow**,
**passed-time-rolls-over**, **dated-unchanged**, **no-time-still-asks**, **unit-regression**.

## Out of scope

Part-of-day words without a clock time ("в обід", "ввечері") still ask; logging the transcript.
