---
id: 0008-recurrence-end-ignored
state: IN-TESTING
severity: high
attempt: 0
max_attempts: 3
branch: fix/0008-recurrence-end-ignored
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: unit-stops-at-until
    assert: "npm test passes and includes a regression test, failing on the pre-fix code, in which a daily 07:00 Europe/Kyiv rule with until 2026-11-19 gives nextOccurrenceAfter(2026-11-18T07:00+02:00) == 2026-11-19T07:00:00+02:00 and nextOccurrenceAfter(2026-11-19T07:00+02:00) == undefined, and enqueueNextOccurrence writes no notification after the last occurrence"
  - id: repro-fixed
    assert: "With X-Test-Now=2026-11-05T11:48:00+02:00, from user 900000001 POST 'На протязі наступних 14 днів кожного дня з ранку о 7:00 ранку нагадуй мені, що мені потрібно пройти сертифікацію.'; '/export' from 900000001 shows exactly one reminder whose recurrence has freq == 'daily', atLocal == '07:00' and until == '2026-11-19', with exactly one scheduled notification at 2026-11-06T07:00:00+02:00; the reply starts with 'Нагадування збережено:' and contains 'до 19 листопада'"
  - id: stops-after-end
    assert: "Continuing repro-fixed for user 900000001: POST /sweep (valid X-Sweep-Secret) with X-Test-Now=2026-11-19T06:45:00+02:00; '/export' from 900000001 shows no notification whose at is later than 2026-11-19T07:00:00+02:00 and no notification in status 'scheduled'; a further POST /sweep with X-Test-Now=2026-11-20T06:45:00+02:00 reflects no string starting with 'Нагадування:' that contains 'сертифікац' (case-insensitive)"
  - id: until-date
    assert: "With X-Test-Now=2026-11-25T10:00:00+02:00, from user 900000002 POST 'Щодня о 9 вечора до 1 грудня нагадуй мені пити вітаміни'; '/export' from 900000002 shows exactly one reminder whose recurrence has freq == 'daily', atLocal == '21:00' and until == '2026-12-01'"
  - id: no-end-unchanged
    assert: "With X-Test-Now=2026-11-25T10:00:00+02:00, from user 900000003 POST 'Нагадуй мені щодня о 8 ранку робити зарядку'; '/export' from 900000003 shows exactly one reminder whose recurrence has freq == 'daily', atLocal == '08:00' and no until field"
  - id: birthday-unchanged
    assert: "With X-Test-Now=2026-11-25T10:00:00+02:00, from user 900000004 POST 'У Олени день народження 12 червня'; '/export' from 900000004 shows exactly one reminder whose recurrence has freq == 'yearly', month == 6, day == 12 and no until field"
failures: []
---

# BUG-0008 - A repeat's end ("протягом 14 днів", "до 1 грудня") is dropped; it fires forever

## Symptom

The owner asked on 2026-11-05: "На протязі наступних 14 днів кожного дня з ранку о 7:00 ранку
нагадуй мені, що мені потрібно пройти сертифікацію." The bot stored a plain daily 07:00 reminder.
The 14 days ended on 2026-11-19, but it kept firing every morning (20 deliveries by 2026-11-25, the
next one already armed) and would never stop. Tapping Done on each delivery did not stop it either,
because a recurring reminder only closes when none of its notifications is pending, and the next
occurrence is always armed. Nothing in the reply said the "14 days" part was ignored. The prod
reminder (`users/281473866/reminders/fHfJKsYN3VVluVxwn9w4`) was closed by hand on 2026-11-25.

## Reproduction

On the test function, with `X-Test-Now=2026-11-05T11:48:00+02:00`, send the message above from
`900000001`. `/export` shows `recurrence: {freq: daily, atLocal: "07:00", timezone: Europe/Kyiv}` -
no end. A `/sweep` at `2026-11-19T06:45+02:00` delivers the 19th and arms 2026-11-20, and so on.

## Root cause

- [src/reminders/recurrence.ts](../../src/reminders/recurrence.ts) `Recurrence` has no end field,
  so there is nowhere to keep one; `nextOccurrence` / `nextOccurrenceAfter` always return a date.
- [src/classifier/classifier.service.ts](../../src/classifier/classifier.service.ts) recurrence
  `responseSchema` has no field for a term or an end date, so the model has no way to emit it.
- [src/reminders/reminders.service.ts](../../src/reminders/reminders.service.ts)
  `enqueueNextOccurrence` re-arms unconditionally after each delivery.

## Fix

- `Recurrence` gains optional `until?: string` - a local calendar date `YYYY-MM-DD` in the rule's
  `timezone`, **inclusive** (the last day an occurrence may fall on). Absent means no end, exactly
  as today; it is never filled with a placeholder.
- `nextOccurrence` / `nextOccurrenceAfter` return `undefined` when the resolved occurrence's local
  date is after `until`.
- The classifier's recurrence object gains two optional fields, at most one of them used:
  `until` ("до 1 грудня" -> that local date, resolved against the current local time in the prompt)
  and `forDays` (integer, "протягом 14 днів" / "for two weeks" -> 14). The model never computes a
  date from `forDays`; code does: `until` = local date of the **first occurrence** + `forDays - 1`
  days (luxon calendar days, not 24h), so "for N days, every day" is exactly N occurrences. Both
  fields are OMITTED unless the message states an end; a term is never inferred. An `until` that
  does not parse as a date, or `forDays` that is not a positive integer, is dropped like any other
  bad field - but a stated end that cannot be kept must not silently become "forever": the reminder
  item's confidence is forced below `CONFIDENCE_ASK` (same rule as a payload that fails validation),
  so the bot asks instead.
- `enqueueNextOccurrence`: when the next occurrence is `undefined` because the rule has ended, write
  nothing and log `Reminder {id} recurrence ended` (ids only). The reminder then closes the normal
  way when its last delivered notification is acked.
- Creating a reminder whose `until` is before its first occurrence is not stored (the bot asks), the
  same path as an unresolvable rule.
- `describeRecurrence` appends ` до {day} {month genitive}` when `until` is set ("щодня о 07:00 до
  19 листопада"), so the reply shows the end was understood.
- `until` is kept by `normalizeRecurrence` when re-validating a stored rule, and appears in
  `/export` as part of `recurrence`.

## Fix scope

- `src/reminders/recurrence.ts`
- `src/reminders/reminders.service.ts`
- `src/classifier/classifier.service.ts` (schema, prompt rules + one example each for `forDays` and
  `until`, coercion)
- `test/recurrence.spec.ts`, `test/reminders.service.spec.ts`, `test/classifier.reminder.spec.ts`

## Invariants (must not break)

- Recurrence is stored as local wall-clock + timezone, never a UTC instant; `until` is a local date,
  and day arithmetic uses calendar days (DST days are 23/25 h).
- Absent stays absent: no `until` unless the message states an end; `forDays` never stored.
- The classifier never throws on a bad model reply; bad fields are dropped, not repaired.
- `enqueueNextOccurrence` stays idempotent (transaction + "already scheduled" guard).
- Replies set no `parse_mode`; no raw timestamp in a reply (the end date goes through the same
  Ukrainian month-genitive rendering).
- Never log reminder text - ids and counts only.

## Acceptance criteria (locked at READY)

See front matter: `unit-stops-at-until`, `repro-fixed`, `stops-after-end`, `until-date`, plus
no-regression `no-end-unchanged` and `birthday-unchanged`.

## Out of scope

- "every other day", "N times" counts on weekly/monthly rules (`forDays` covers a term in days; a
  "for 3 weeks" term is `forDays: 21`).
- Editing the end of an already stored reminder.
- Back-filling `until` onto existing prod reminders.
