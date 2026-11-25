---
id: 0008-recurrence-end-ignored
state: IMPLEMENTED
severity: high
attempt: 1
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
    assert: "Continuing repro-fixed for user 900000001 (catch-up delivers one occurrence per sweep, by design): repeat POST /sweep (valid X-Sweep-Secret) with X-Test-Now=2026-11-20T06:45:00+02:00 until a sweep reflects no string starting with 'Нагадування:' that contains 'сертифікац' (case-insensitive), at most 20 sweeps; exactly 14 such strings were reflected in total; '/export' from 900000001 then shows exactly 14 notifications, at 2026-11-06T07:00:00+02:00 through 2026-11-19T07:00:00+02:00, none later than 2026-11-19T07:00:00+02:00 and none in status 'scheduled'"
  - id: until-date
    assert: "With X-Test-Now=2026-11-25T10:00:00+02:00, from user 900000002 POST 'Щодня о 9 вечора до 1 грудня нагадуй мені пити вітаміни'; '/export' from 900000002 shows exactly one reminder whose recurrence has freq == 'daily', atLocal == '21:00' and until == '2026-12-01'"
  - id: no-end-unchanged
    assert: "With X-Test-Now=2026-11-25T10:00:00+02:00, from user 900000003 POST 'Нагадуй мені щодня о 8 ранку робити зарядку'; '/export' from 900000003 shows exactly one reminder whose recurrence has freq == 'daily', atLocal == '08:00' and no until field"
  - id: birthday-unchanged
    assert: "With X-Test-Now=2026-11-25T10:00:00+02:00, from user 900000004 POST 'У Олени день народження 12 червня'; '/export' from 900000004 shows exactly one reminder whose recurrence has freq == 'yearly', month == 6, day == 12 and no until field"
failures:
  - attempt: 0
    stage: verification
    detail: >-
      One criterion fails as written: stops-after-end. The fix itself works, but the criterion's single-sweep
      setup cannot pass, so the owner needs to amend it. testing = 46066b0 (fix + lane commit) was proven
      live at 15:00:43 UTC: 'Щодня о 9 вечора до 1 грудня ...' on spare user 900000006 stored recurrence
      until '2026-12-01' and replied '... до 1 грудня', which only the fix can produce. PASS: health (GET /
      200 {"status":"ok"}); unit-stops-at-until (npm test 411/411; on the tests-only commit e922261 the 16
      new BUG-0008 tests fail, among them 'stops a daily rule after its inclusive until date' and 'writes
      nothing after the last occurrence'); repro-fixed (900000001, now 2026-11-05T11:48+02:00: reply
      'Нагадування збережено: потрібно пройти сертифікацію\nЗавтра о 7:00\nПовторюється: щодня о 7:00 до 19
      листопада', one reminder {daily, 07:00, Europe/Kyiv, until 2026-11-19}, one scheduled notification at
      2026-11-06T07:00:00+02:00); until-date (900000002: {daily, 21:00, until 2026-12-01});
      no-end-unchanged (900000003: {daily, 08:00}, no until); birthday-unchanged (900000004: {yearly,
      month 6, day 12}, no until). FAIL: stops-after-end. POST /sweep at 2026-11-19T06:45+02:00 reflected
      'Нагадування: потрібно пройти сертифікацію\n6 листопада о 7:00'. After it, /export for 900000001 showed
      the 11-06 notification sent and a new 2026-11-07T07:00:00+02:00 notification 'scheduled', which
      breaks the "no notification in status 'scheduled'" part. The next sweep at 2026-11-20T06:45 then
      reflected 'Нагадування: потрібно пройти сертифікацію\n7 листопада о 7:00'. The cause is the existing
      catch-up rule, which this fix leaves alone and its scope does not cover: each tick delivers one
      occurrence and arms the next one, counted from the occurrence that just fired (enqueueNextOccurrence,
      spec 0003 accepts late catch-up). So one jump from 11-05 to 11-19 delivers the 6th, not the 19th, and
      no code change within this fix's scope can meet the criterion as written. Diagnostic run (not a
      criterion): 12 more sweeps at 2026-11-20T06:45 delivered 11-08 through 11-19, one per tick. The 13th
      and 14th returned replies []. /export then listed 14 notifications (11-06 to 11-19), all 'sent', none
      after 2026-11-19T07:00 and none 'scheduled'. So the end is respected. Owner decision needed: amend
      stops-after-end, for example to repeat POST /sweep at 2026-11-20T06:45 until it reflects no
      certification reminder and then assert the export, or decide on a catch-up policy in a spec. Sending
      it back to the implementer unchanged will not help. Side note: the first poll, the same repro message
      on 900000005 with now 2026-11-25T11:48, came back as a clarify reply (0.49) and stored nothing; the
      same request repeated later stored until 2026-12-09 correctly. Security pass PASS.
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
no end. Sweeping past the end keeps delivering one occurrence per sweep (catch-up) and arms 2026-11-20, 2026-11-21, and so on, forever.

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

## Criterion amendment (2026-11-25, after attempt 1)

`stops-after-end` originally assumed one sweep at 2026-11-19 lands on the 19th occurrence. The
existing catch-up rule delivers one occurrence per sweep, counted from the one that just fired, so
the criterion now sweeps repeatedly and checks the total (14) and that nothing is armed after the
end. The code was not changed; attempt 1 already showed this behaviour (14 deliveries, then none).
