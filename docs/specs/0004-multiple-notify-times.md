---
id: 0004-multiple-notify-times
state: DONE
attempt: 0
max_attempts: 3
branch: feat/0004-multiple-notify-times
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: two-notifications-captured
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'I have a doctor appointment on the 22nd at 2PM, remind me the evening before and the morning of' from user id U1; a '/export' from U1 shows one reminder with eventAt == '2026-09-22T14:00:00+03:00' and exactly two notifications with status 'scheduled', one at '2026-09-21T19:00:00+03:00' (evening before) and one at '2026-09-22T09:00:00+03:00' (morning of)"
  - id: single-default-notification
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Remind me on the 25th at 12 to pay rent' from user id U2 (no extra notify phrasing); a '/export' from U2 shows one reminder with exactly one notification at '2026-09-25T12:00:00+03:00' (equal to eventAt) - the single-time path is unchanged"
  - id: independent-delivery
    assert: "Using U1 from two-notifications-captured, POST /sweep (valid secret) with X-Test-Now=2026-09-21T18:45:00+03:00; the reflected replies contain exactly one delivery, and a '/export' from U1 shows the 2026-09-21T19:00 notification status == 'sent' while the 2026-09-22T09:00 notification is still 'scheduled'"
  - id: ok-acks-only-that-notification
    assert: "Read the sent notification id from U1's '/export'. POST a callback_query (valid webhook secret, from = U1) with data 'rem:ok:{notificationId}'; a '/export' from U1 shows that notification 'acked' and the other notification still 'scheduled'"
  - id: snooze-moves-only-that-notification
    assert: "For a delivered notification owned by user id U3, POST a callback_query from U3 with data 'rem:1h:{notificationId}' and X-Test-Now=2026-09-21T19:05:00+03:00; a '/export' from U3 shows that notification back to 'scheduled' with at == '2026-09-21T20:05:00+03:00', and the reminder's other notifications unchanged"
failures:
  - attempt: 0
    stage: verification
    detail: >-
      Verification could not complete: the sweep delivers nothing on the test function. Capture works (criteria health, two-notifications-captured, single-default-notification all PASS against the live test deploy of 2a09399), but POST /sweep returns 200 with zero reflected deliveries at every pinned now, and notifications that are status 'scheduled' with at <= cutoff stay 'scheduled'. backfillLegacy succeeds in the same tick (legacy reminders gained notifications and lost remindAt), which isolates the failure to RemindersService.findDue - the notifications collection-group query on (status ==, at <=). The composite index that query needs - collection group 'notifications', scope Collection group, fields status Asc then at Asc - is new in this spec and does not exist on the 'test' Firestore database; README step 5 predicts exactly this FAILED_PRECONDITION symptom. Creating it is a manual Cloud Console action neither worker agent is permitted to perform, so this is an environment blocker, not a code defect: criteria independent-delivery, ok-acks-only-that-notification and snooze-moves-only-that-notification were NOT observable and are therefore NOT passed. Security pass over git diff main...feat/0004-multiple-notify-times: PASS. Re-run verification once the index is Enabled on 'test'. attempt left at 0 - no implementation rework attempt was consumed.
---

# 0004 - Multiple notify times per reminder

## Context

One event can deserve several nudges. "I have a doctor appointment next Tuesday at 2PM, remind me the
evening before and the morning of" is a single appointment with **two** notification times. Specs 0002
and 0003 model exactly one notify instant per reminder (`remindAt`), so they cannot express this.

This spec makes notifications first-class: a reminder still has one `eventAt` (when the thing
happens), but zero-or-more **notification** records (when to nudge), each delivered and button-managed
on its own. It is an evolution of [0003](0003-reminder-delivery.md), not a rewrite - the cron, the
sweep secret, the transaction pattern and the callback plumbing all carry over; what changes is that
the sweep and the buttons operate on notification records instead of a scalar `remindAt`.

**Depends on 0002 and 0003 being merged to `main`.** No data is lost by having shipped the single
-time versions first: 0002 stores `originalText` verbatim, so a message that asked for two nudges but
was captured as one can be re-derived. A one-time backfill (below) converts existing single-`remindAt`
reminders into one notification each.

## Scope

- `src/reminders/` - introduce the `notifications` subcollection and its writes/reads; retire the
  scalar `remindAt` as the delivery source of truth; add the migration/backfill.
- `src/classifier/classifier.service.ts` + `classifier.types.ts` - the reminder payload gains an
  array of resolved notify instants; the prompt learns to extract several, resolving relative
  phrases ("the evening before", "the morning of the appointment") against `eventAt`, `now` and the
  timezone.
- `src/telegram/sweeper.service.ts` - sweep the `notifications` collection group, deliver each due
  notification, claim-and-send per notification.
- `src/telegram/telegram.service.ts` - `callback_data` now keys on a notification id; buttons act on
  that one notification.
- `.env.example`, `README.md` - the new collection-group index on `notifications (status, at)`.
- `test/` - unit tests for multi-notify resolution and the per-notification sweep/snooze math.

Out of bounds without returning to `DRAFT`: recurrence (that is [0005](0005-recurring-reminders.md)),
transcription, and the webhook response contract.

## Contracts

**Notification records.** `users/{userId}/reminders/{reminderId}/notifications/{autoId}` with: `at`
(Firestore `Timestamp`, the instant to fire), `atLocal` (canonical local-ISO-with-offset string, as
`eventAt` is formatted), `status` (`scheduled` | `sent` | `acked`), `sentAt?`, and - denormalised so
the sweep needs no parent read - `reminderId`, `userId`, `chatId`, and `title`.

**Capture.** The classifier resolves each requested notify phrase to an instant and returns them as an
array on the reminder payload. `RemindersService.create` writes the reminder plus one notification
doc per resolved instant. **Defaults:** "morning" = 09:00 local, "evening" = 19:00 local (fixed for
v1). If the message names **no** notify time, write exactly one notification at `eventAt` - so the
0002/0003 single-time behaviour is preserved.

**Sweep.** `cutoff = now + REMINDER_SWEEP_INTERVAL_MINUTES` (unchanged). `findDue` becomes a
`notifications` collection-group query on `status == 'scheduled'` and `at <= cutoff`. Claim-and-send
(the transaction from 0003) now flips a **notification** `scheduled -> sent`, so two ticks cannot
double-notify a single nudge, and the other notifications of the same reminder are untouched.

**Buttons.** `callback_data` becomes `rem:ok:{notificationId}` / `rem:1h:{notificationId}` /
`rem:tmrw:{notificationId}`. `OK` acks **that** notification only (the reminder's other notifications
still fire). `+1h` and `Tomorrow` move **that** notification's `at`, `status -> scheduled`. The owner
check reads the notification's denormalised `userId`.

**`/export`.** Each reminder item gains `notifications: [{ id, at, status }]` (each `at` in canonical
local-ISO form); the retired scalar `remindAt` is dropped from the item.

**Backfill (one-time, prod only).** On first deploy, convert each existing reminder's `remindAt` into
a single `scheduled` notification, then stop reading `remindAt`. The verifier's test database is
fresh, so this is documented but not an acceptance criterion.

## Invariants (must not break)

- Everything 0003 locked still holds: `200`-always webhook, `401`-only-on-bad-secret sweep, the
  `ALLOWED_USERS` gate and owner check before any callback acts, no `parse_mode`, and the "ids and
  counts, not content" logging rule (never log `title` or `originalText`).
- Double-notify is impossible: the `scheduled -> sent` flip is transactional, per notification.
- A reminder that names one time (or none) still produces exactly one notification - no regression
  for the common case.
- Snooshing or acking one notification never changes another notification of the same reminder, and
  never moves `eventAt`.

## Acceptance criteria (locked)

See frontmatter. Distinct `from.id` per test for isolation; "now" pinned per request. The engine is
proven by: two nudges captured from one appointment, the single-time case still yielding one
notification, each notification delivered and swept independently, and buttons acting on exactly one.

Unit tests (deterministic): resolving "evening before"/"morning of" against an `eventAt` (including
the 19:00 / 09:00 defaults); the per-notification sweep cutoff; and the per-notification snooze math.

## Out of scope

- **Recurrence / never-expiring** reminders - [0005](0005-recurring-reminders.md).
- A "stop all reminders for this" button or any reminder-management UI beyond the three per
  -notification buttons.
- Smarter natural-language notify phrases beyond the fixed morning/evening defaults and explicit
  offsets; anything unresolved falls back to a single notification at `eventAt`.
