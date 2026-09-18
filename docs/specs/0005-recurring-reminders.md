---
id: 0005-recurring-reminders
state: DONE
attempt: 0
max_attempts: 3
branch: feat/0005-recurring-reminders
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: birthday-captured-yearly
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Bob has a birthday on June 12' from user id U1; a '/export' from U1 shows one reminder with a non-empty title, recurrence == yearly on month 6 day 12, no expireAt (null/absent), and exactly one scheduled notification at the next occurrence '2027-06-12T09:00:00+03:00'"
  - id: never-expires
    assert: "The reminder from birthday-captured-yearly has no expireAt field (so the Firestore TTL policy can never delete it)"
  - id: recurrence-rolls-forward
    assert: "For U1's birthday reminder, POST /sweep (valid secret) with X-Test-Now=2027-06-12T08:50:00+03:00; the reflected replies contain one delivery, and a following '/export' from U1 shows the just-fired notification 'sent' and a NEW scheduled notification at '2028-06-12T09:00:00+03:00'"
  - id: recurrence-dst-winter
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Remind me every year on December 25 at 10:00 to call grandma' from user id U2; a '/export' from U2 shows a scheduled notification at '2026-12-25T10:00:00+02:00' (winter offset, proving the time is stored as local wall-clock and DST is applied per occurrence)"
  - id: weekly-recurrence
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Take out the trash every Monday at 8am' from user id U3; a '/export' from U3 shows a weekly recurrence on Monday and one scheduled notification at '2026-09-21T08:00:00+03:00' (the next Monday)"
failures: []
---

# 0005 - Recurring reminders and birthdays

## Context

Some reminders never end. "Bob has a birthday on June 12" should fire every year, forever, and must
never be TTL-deleted. This spec adds recurrence and a no-expiry path, built on the notification model
from [0004](0004-multiple-notify-times.md): a recurring reminder always has exactly **one** scheduled
notification - its next occurrence - and when that fires, the sweeper enqueues the following one. So
recurrence reuses 0004's delivery machinery and adds only "compute the next occurrence".

**The birthday-is-actor_info question, handled pragmatically.** In the taxonomy a birthday is
`actor_info`, meant to live on a person record ([../architecture.md](../architecture.md) section 4) -
but actors are Phase 5 and not built. Rather than block birthdays on actors, this spec routes a
recurring-date statement to a **recurring reminder** now. When actors land, birthdays migrate onto the
person; `originalText` is preserved, so that backfill is a re-derivation, not a loss.

**Depends on 0002, 0003 and 0004 being merged to `main`.**

## Scope

- `src/classifier/classifier.service.ts` + `classifier.types.ts` - detect recurrence in reminder-type
  messages (birthday/anniversary phrasing, "every Monday", "every year on...", "on the 1st of each
  month") and emit a structured `recurrence` payload; do **not** invent a recurrence that was not
  stated.
- `src/reminders/` - store `recurrence`; omit `expireAt` for recurring reminders; a DST-aware
  next-occurrence resolver; on delivery of a recurring notification, enqueue the next occurrence.
- `src/telegram/sweeper.service.ts` - after a recurring notification is sent, schedule the next one
  (inside/after the same claim, idempotently).
- `src/clock/clock.service.ts` (or a `recurrence` helper) - "next occurrence at or after now" for
  daily / weekly / monthly / yearly, resolving local wall-clock to an instant with DST applied.
- `README.md` - note that recurring reminders carry no `expireAt` and so are exempt from the TTL
  policy by design (no Console change needed).
- `test/` - unit tests for the next-occurrence resolver across frequencies and across a DST boundary.

Out of bounds without returning to `DRAFT`: actors/person records, transcription, the webhook
contract, and any UI to cancel or edit a recurrence (see Out of scope).

## Contracts

**Recurrence, stored as local wall-clock plus timezone - never a UTC instant** (the DST rule from
[../architecture.md](../architecture.md) section 8). Shape on the reminder:
`recurrence: { freq: 'daily'|'weekly'|'monthly'|'yearly', month?, day?, weekday?, atLocal: 'HH:mm',
timezone }`. Examples: a birthday is `{ freq:'yearly', month:6, day:12, atLocal:'09:00' }`; "every
Monday at 8am" is `{ freq:'weekly', weekday:'monday', atLocal:'08:00' }`. **Default time** for an
all-day recurring event (a birthday with no time) = 09:00 local.

**No expiry.** A recurring reminder is written with **no** `expireAt` field. Firestore's TTL policy
only deletes documents where the field is present, so absence means "never expires" with no extra
code. Its notifications likewise carry no `expireAt`.

**Next-occurrence resolver.** Given the recurrence and `now`, compute the next occurrence strictly at
or after `now` and resolve its local wall-clock to a UTC instant with the correct DST offset for that
date. This is why the time is stored as `atLocal` + timezone, not as an instant: "09:00 on June 12"
is 06:00 UTC in summer and would be 07:00 UTC if it fell in winter.

**Rolling delivery.** A recurring reminder always has exactly one `scheduled` notification: its next
occurrence. When the sweeper delivers it (`scheduled -> sent`, transactional, from 0003/0004), it then
enqueues a new `scheduled` notification at the following occurrence. This step must be idempotent - a
retried tick must not create two future notifications (guard by the transactional claim, and by an
"only enqueue if none scheduled" check).

**Buttons.** Unchanged from 0004, acting on the fired occurrence's notification: `OK` acks this
occurrence (the next is already scheduled); `+1h` / `Tomorrow` snooze **this** occurrence only and do
not alter the recurrence. There is no "stop recurring" button in v1.

**`/export`.** Each reminder item gains `recurrence` (or `null`), and recurring items show `expireAt`
as `null`/absent.

## Invariants (must not break)

- Everything 0003 and 0004 locked still holds (transactional no-double-notify, the gate and owner
  check, no `parse_mode`, content-free logging).
- Recurrence is **never invented**: a one-off reminder must not become recurring because of a vague
  word. Only explicit recurring phrasing produces a `recurrence`.
- A recurring reminder is never TTL-deleted (no `expireAt`), and always has exactly one future
  `scheduled` notification after each delivery - it can neither pile up duplicates nor stop.
- Occurrence times are computed from local wall-clock + timezone, so a summer and a winter occurrence
  of the same rule resolve to the correct, different UTC instants.

## Acceptance criteria (locked)

See frontmatter. Proven by: a birthday captured as a yearly, no-expiry reminder with its next
occurrence scheduled; the occurrence rolling forward a year after it fires; a winter occurrence
carrying the +02:00 offset (DST correctness); and a weekly rule resolving to the next weekday.

Unit tests (deterministic): the next-occurrence resolver for daily/weekly/monthly/yearly, including a
rule whose next occurrence crosses a DST boundary; and the "enqueue exactly one next occurrence"
idempotency.

## Out of scope

- **Actors / person records.** Birthdays are recurring reminders here; migrating them onto people is
  Phase 5.
- **Cancelling or editing** a recurrence (a "stop"/"skip this one" control) - a later spec.
- **Complex rules** (every second Tuesday, weekdays-only, "last day of the month"). v1 covers
  daily / weekly / monthly / yearly on a fixed day and time.
- **Lead-time** interplay with recurrence beyond the fixed default time.
