---
id: 0003-reminder-lost-on-send-failure
state: IMPLEMENTED
severity: high
attempt: 0
max_attempts: 3
branch: fix/0003-reminder-lost-on-send-failure
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: repro-fixed
    assert: "npm test passes and includes a regression test, failing on the pre-fix code, in which sendReminder throws once for a due notification and a later sweep() sends it"
  - id: gives-up
    assert: "npm test includes a passing test: after 3 failed send attempts across 3 sweeps the notification has status 'failed', is no longer returned by findDue, and a 4th sweep does not try to send it"
  - id: recurrence-once
    assert: "npm test includes a passing test: a recurring notification whose first send fails and second succeeds ends with exactly one next-occurrence notification in status 'scheduled'"
  - id: delivery-unchanged
    assert: "With X-Test-Now=2026-12-01T09:00:00+02:00, from user 900000006 POST 'Remind me today at 14:00 to water the plants'; POST /sweep (valid X-Sweep-Secret) with X-Test-Now=2026-12-01T13:45:00+02:00 and the reflected replies contain exactly one string starting with 'Нагадування:' that contains 'water the plants'; a second POST /sweep at the same X-Test-Now reflects no such string; '/export' from 900000006 shows that notification with status 'sent'"
failures: []
---

# BUG-0003 - A reminder whose Telegram send fails is never delivered

> **READY 2026-11-16** (owner). Found the same day in a housekeeping review, by reading the code.
> Decision: at most **3 send attempts** (3 sweeps, about 90 minutes), then status `failed`. A failed
> send cannot be produced on the test function (reflect mode swallows send errors), so the failure
> criteria are unit tests and the HTTP criterion checks that normal delivery is unchanged.

## Symptom

If Telegram is briefly unavailable when a reminder is due (a 5xx, a 429 rate limit, a network
timeout), that reminder never arrives. Nothing tells the user. The log shows
`Failed to deliver notification <id>` once, and later sweeps never try again.

## Reproduction

Unit level: in `SweeperService.sweep`, make `TelegramService.sendReminder` throw once for a due
notification. Expected today: `claimForSend` has already flipped it to `sent`, the next `sweep` call
does not find it in `findDue`, and it is never sent.

## Root cause

[sweeper.service.ts](../../src/telegram/sweeper.service.ts) claims, then sends. `claimForSend`
([reminders.service.ts](../../src/reminders/reminders.service.ts), around line 485) moves the
notification from `scheduled` to `sent` *before* the send, which correctly prevents double sends.
But when `sendReminder` throws, the catch only logs it. The notification stays `sent`, and
`findDue` only queries `status == 'scheduled'`, so it is gone. A notification with no `chatId`
(read as `0`) fails the same way, every time.

## Fix scope

- `src/telegram/sweeper.service.ts`: on a send failure, put the claimed notification back to
  `scheduled` (or into a retryable state) with an attempt counter.
- `src/reminders/reminders.service.ts`: the release/attempt write.
- `test/`: a regression test for the failed-send case.

Decided: a failed send puts the notification back to `scheduled` and increments a `sendAttempts`
counter on it. After the 3rd failed attempt it becomes `failed`, logged with the id only.

## Invariants (must not break)

- No double send. The claim transaction stays the only path to sending.
- A recurring reminder's next occurrence is armed exactly once, not once per retry.
- Logs carry ids only, never the reminder title.

## Acceptance criteria (locked at READY)

- **repro-fixed:** a notification whose first send fails is sent by a later sweep.
- **gives-up:** after the maximum number of attempts it is no longer `scheduled` and is not retried.
- **no-double-send:** two overlapping sweeps over a retried notification send it once.
- **recurrence-once:** a failing recurring notification arms its next occurrence exactly once.

## Out of scope

Telling the user that a reminder failed; alerting.
