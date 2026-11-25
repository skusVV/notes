---
id: 0007-day-without-time-with-nudges-not-stored
state: IMPLEMENTED
severity: medium
attempt: 0
max_attempts: 3
branch: fix/0007-day-without-time-with-nudges-not-stored
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: repro-fixed
    assert: "With X-Test-Now=2026-11-25T16:18:00+02:00, from user 900000001 POST 'В суботу вранці я йду здавати аналізи. Поставив мені нагадування ремайндер на п'ятницю вечір та на суботу 6 ранку.'; '/export' from 900000001 shows exactly one reminder, no recurrence, with exactly two scheduled notifications at 2026-11-27T19:00:00+02:00 and 2026-11-28T06:00:00+02:00; the reply starts with 'Нагадування збережено:' and contains no '(0.49)'"
  - id: day-only-with-nudge
    assert: "With X-Test-Now=2026-11-25T16:18:00+02:00, from user 900000002 POST 'У п’ятницю в мене стоматолог, нагадай мені ввечері напередодні'; '/export' from 900000002 shows exactly one reminder with exactly one scheduled notification at 2026-11-26T19:00:00+02:00; if that reminder has allDay == true, the saved-confirmation reply contains no clock time for the event ('23:59' does not appear anywhere in the reply)"
  - id: bare-hour-nearest
    assert: "With X-Test-Now=2026-11-25T16:18:00+02:00, from user 900000003 POST 'Нагадай мені о 8 подзвонити Сергію'; '/export' from 900000003 shows exactly one reminder whose eventAt == 2026-11-25T20:00:00+02:00"
  - id: meridiem-respected
    assert: "With X-Test-Now=2026-11-25T16:18:00+02:00, from user 900000004 POST 'Нагадай мені о 8 ранку подзвонити Сергію'; '/export' from 900000004 shows exactly one reminder whose eventAt == 2026-11-26T08:00:00+02:00"
  - id: no-time-no-nudge-still-asks
    assert: "With X-Test-Now=2026-11-25T16:18:00+02:00, from user 900000005 POST 'Нагадай мені в четвер подзвонити лікарю'; '/export' from 900000005 shows no reminder"
  - id: bug0006-unchanged
    assert: "With X-Test-Now=2026-11-25T06:10:00+02:00, from user 900000006 POST 'Нагадай мені о пів на восьму вигуляти собаку'; '/export' from 900000006 shows exactly one reminder whose eventAt == 2026-11-25T07:30:00+02:00"
  - id: unit-regression
    assert: "npm test passes and includes regression tests, failing on the pre-fix code, for: (a) a canned reply {hasTimeOfDay: false, eventDate: '2026-11-28', notifyAt: ['evening_before', '2026-11-28T06:00:00+02:00']} at now=2026-11-25T16:18+02:00 keeping confidence and yielding allDay true; (b) the same with no notifyAt staying below CONFIDENCE_ASK; (c) atLocal '08:00', dateStated false, meridiemStated false resolving to 2026-11-25T20:00:00+02:00; (d) RemindersService.create for an allDay one-off writes allDay true and only the requested notifications, never one at eventAt"
failures: []
---

# BUG-0007 - A reminder with a day but no clock time is refused even when the nudge times are explicit

> **READY 2026-11-25** (owner, after BUG-0006 shipped: "Ця проблема не пофікшена ... подивись, в
> чому там проблема"; standing go-ahead to fix without asking). Prod log 14:18 UTC:
> `Classifier returned reminder without a usable payload`, `[reminder 0.49]`. The owner pasted the
> exact message, so the reproduction is exact.

## Symptom

"В суботу вранці я йду здавати аналізи. Поставив мені нагадування ремайндер на п'ятницю вечір та
на суботу 6 ранку." The bot answers "I am not confident this is reminder (0.49)" and stores
nothing, although both nudge times are spelled out.

Second, smaller one found while probing: "Нагадай мені о 8 подзвонити Сергію" at 16:18 is stored
for tomorrow 08:00 instead of today 20:00, ignoring the prompt's "bare hour 1-12 = nearest" rule.

## Reproduction

Real classifier (gemini-3.5-flash-lite), now = 2026-11-25T16:18:00+02:00. The model returns
`hasTimeOfDay: false`, `dateStated: true`, `notifyAt: ["evening_before", "2026-11-28T06:00:00+02:00"]`
and no `eventAt`, so `coerceItem` forces confidence to 0.49.

## Root cause

[classifier.service.ts](../../src/classifier/classifier.service.ts) `coerceItem`: a non-recurring
reminder is resolved only when `hasTimeOfDay === true` and `eventAt` is a future instant. The event
here has a day and no clock time, which invent-nothing correctly refuses to fill in, but the
reminder is still fully actionable because the user named when to be nudged. Nothing models a
one-off "all-day" event; `allDay` exists only on the recurring path
([reminders.service.ts](../../src/reminders/reminders.service.ts) `create`). The `о 8` case is
the model not applying the 12-hour rule; it returns `atLocal: "08:00"` and code trusts it.

## Fix

A prototype of the classifier half was run against the real model and gave the correct result
for every acceptance phrase: `/private/tmp/claude-501/-Users-vitaliiskus-work-notes/ba17ac35-6890-40c8-918d-431f621f238f/scratchpad/0007-prototype.diff`.

1. **Classifier schema**: `eventDate` (`YYYY-MM-DD`, only when a day is named with no clock time)
   and `meridiemStated` (whether the half of the day was said). Both in `propertyOrdering`.
2. **All-day one-off** in `coerceItem`: non-recurring, `hasTimeOfDay !== true`, a valid
   `eventDate`, and at least one `notifyAt` entry (excluding `at_event`) that resolves to a future
   instant -> `eventAt` = 23:59 local on that date, `notifyAt` = only the resolvable entries,
   `allDay = true`; the confidence gate accepts `allDay` in place of `hasTimeOfDay`. With no usable
   nudge it stays below `CONFIDENCE_ASK` (clarify), as today.
3. **Bare hour** in the BUG-0006 branch: when `meridiemStated === false` and the hour is 1-11, take
   the earlier of H:00 and (H+12):00 after now.
4. **Store** (`reminders.service.ts` `create`): write `allDay: true` on a one-off too (and copy it
   onto each notification doc, read back in `findDue` into `DueNotification.allDay`). For an all-day
   one-off, if no requested notify time resolves, return `undefined` (no write) instead of falling
   back to one nudge at the 23:59 `eventAt`.
5. **Display**: an all-day event is never shown with a clock time. Add a pure
   `humanizeDay(iso, now)` to [humanize-time.ts](../../src/reminders/humanize-time.ts)
   (`Сьогодні` / `Завтра` / `Післязавтра` / `28 листопада`, same day logic as `humanizeInstant`).
   In `telegram.service.ts`: the saved confirmation for an all-day one-off is
   `Нагадування збережено: <title>` / `<humanizeDay>` / `Нагадаю: <humanizeInstant of each resolved
   nudge, comma-separated, lower-case>`; `sendReminder` for an `allDay` notification shows
   `humanizeDay(eventAt)` instead of `humanizeInstant`. The digest already lists `allDay` reminders
   title-only.

## Fix scope

- `src/classifier/classifier.service.ts`, `src/classifier/classifier.types.ts` (only if a type needs it)
- `src/reminders/reminders.service.ts`, `src/reminders/humanize-time.ts`
- `src/telegram/telegram.service.ts` (`handleReminder` confirmation, `sendReminder`)
- tests: `test/classifier.reminder.spec.ts`, `test/reminders.service.spec.ts`,
  `test/humanize-time.spec.ts`, `test/telegram.service.spec.ts`

## Invariants (must not break)

- Invent-nothing: no clock time and no nudge -> clarify. 23:59 is a storage sentinel, never shown.
- Recurring reminders unchanged (their `allDay` path and 09:00 default stay as they are).
- BUG-0006 behaviour unchanged. No raw timestamp in the chat. Classifier never throws.
- Done on an all-day one-off closes it like any one-off (BUG-0004).

## Out of scope

Part-of-day words with no nudge ("в обід" alone still asks). Showing nudge times in confirmations
of ordinary (timed) reminders.
