---
id: 0004-done-does-not-close-after-ignored-nudge
state: IN-PROGRESS
severity: medium
attempt: 0
max_attempts: 3
branch: fix/0004-done-does-not-close-after-ignored-nudge
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: repro-fixed
    assert: "With X-Test-Now=2026-12-01T09:00:00+02:00, from user 900000001 POST 'I have a dentist appointment on December 10 at 2PM, remind me the evening before and the morning of'; '/export' shows one reminder with two scheduled notifications, at 2026-12-09T19:00:00+02:00 and 2026-12-10T09:00:00+02:00. POST /sweep (valid X-Sweep-Secret) with X-Test-Now=2026-12-09T18:45:00+02:00 (first delivered, nobody taps), then POST /sweep with X-Test-Now=2026-12-10T08:45:00+02:00 (second delivered); POST a callback_query from 900000001 with data 'rem:ok:{second notification id}'; a '/export' from 900000001 shows the reminder status == 'acked' and neither notification in status 'scheduled' or 'sent'"
  - id: later-nudge-cancelled
    assert: "With X-Test-Now=2026-12-01T09:00:00+02:00, from user 900000002 POST 'I have a dentist appointment on December 10 at 2PM, remind me the evening before and the morning of'; POST /sweep with X-Test-Now=2026-12-09T18:45:00+02:00 (first delivered); POST a callback_query from 900000002 with data 'rem:ok:{first notification id}'; '/export' from 900000002 shows the reminder status == 'acked', the first notification 'acked' and the second 'cancelled'; then POST /sweep with X-Test-Now=2026-12-10T08:45:00+02:00 and its reflected replies contain no string starting with 'Нагадування:' that contains 'dentist' (case-insensitive)"
  - id: recurring-unchanged
    assert: "With X-Test-Now=2026-12-01T06:00:00+02:00, from user 900000003 POST 'Remind me every day at 15:00 to take vitamins'; POST /sweep with X-Test-Now=2026-12-01T14:45:00+02:00; POST a callback_query from 900000003 with data 'rem:ok:{that notification id}'; '/export' shows that notification 'acked', the reminder status still 'scheduled', and exactly one notification 'scheduled' at 2026-12-02T15:00:00+02:00"
  - id: unit-regression
    assert: "npm test passes and includes a regression test, failing on the pre-fix code, for ackNotification on a non-recurring reminder with one earlier notification left 'sent'"
failures: []
---

# BUG-0004 - Done does not close a reminder if an earlier nudge was left untapped

> **READY 2026-11-16** (owner). Found the same day in a housekeeping review, by reading the code.
> Decision: Done on a non-recurring reminder closes it, acks its other delivered nudges and cancels
> the ones that have not fired yet.

## Symptom

A one-off reminder with two nudges ("remind me a day before and an hour before"): the first nudge
arrives and the user ignores it, the second arrives and the user taps **Done**. The reminder stays
open and keeps showing in the morning digest, although spec 0023 says Done closes it.

## Reproduction

Unit level, in `test/reminders.service.spec.ts`: a non-recurring reminder with two notifications,
the first `sent` (delivered, never tapped), the second `sent`. Call `ackNotification` on the second.
Expected today: the reminder's own `status` is not `acked`.

## Root cause

`ackNotification` ([reminders.service.ts](../../src/reminders/reminders.service.ts), around line 560)
closes the reminder only when no notification is still `scheduled` or `sent`. A delivered but
untapped nudge stays `sent` forever: nothing ever moves it on. So one ignored earlier nudge blocks
the close. The existing 0023 test covers only a reminder with a single notification.

## Fix scope

- `src/reminders/reminders.service.ts`: when Done is tapped on a **non-recurring** reminder, close
  the reminder and mark its other open notifications done: `sent` ones as acked, and `scheduled`
  ones cancelled so they no longer fire. Recurring reminders keep today's behaviour.
- `test/reminders.service.spec.ts`: a regression test.

Decided (owner, 2026-11-16): yes. Done on any nudge of a non-recurring reminder cancels its
not-yet-fired nudges (status `cancelled`), because Done means the thing itself is done.

## Invariants (must not break)

- A recurring reminder never closes on Done; its next occurrence stays armed.
- Snooze and "not yet" are unchanged.

## Acceptance criteria (locked at READY)

- **repro-fixed:** the reproduction above leaves the reminder `acked`.
- **later-nudge-cancelled:** Done on the first of two nudges leaves no notification `scheduled` for
  that reminder, and a later sweep sends nothing for it.
- **recurring-unchanged:** the existing recurring-ack tests still pass.

## Out of scope

The interval-reminder follow-ups of spec 0009.
