---
id: 0008-human-readable-times
state: IN-TESTING
attempt: 0
max_attempts: 3
branch: feat/0008-human-readable-times
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: auth-401
    assert: "POST any update with a wrong X-Telegram-Bot-Api-Secret-Token returns HTTP 401"
  - id: today-form
    assert: "With X-Test-Now=2026-09-21T08:00:00+03:00, POST 'Нагадай сьогодні о 20:00 випити ліки' from user id U50; a '/export' from U50 shows exactly one reminder with eventAt == '2026-09-21T20:00:00+03:00', and the reflected replies for that POST contain a line exactly equal to 'Сьогодні о 20:00' and a line starting with 'Нагадування збережено: '; no reflected reply for that POST contains the substring 'when:' or the substring '+03:00'"
  - id: tomorrow-form-ob
    assert: "With X-Test-Now=2026-09-21T08:00:00+03:00, POST 'Нагадай завтра об 11:00 здати аналізи' from user id U51; a '/export' from U51 shows exactly one reminder with eventAt == '2026-09-22T11:00:00+03:00', and the reflected replies contain a line exactly equal to 'Завтра об 11:00' (the preposition is 'об', not 'о', for hour 11)"
  - id: day-after-form
    assert: "With X-Test-Now=2026-09-21T08:00:00+03:00, POST 'Нагадай післязавтра о 9:30 подзвонити в клініку' from user id U52; a '/export' from U52 shows exactly one reminder with eventAt == '2026-09-23T09:30:00+03:00', and the reflected replies contain a line exactly equal to 'Післязавтра о 9:30' (hour has no leading zero, minutes are always two digits)"
  - id: date-form-same-year
    assert: "With X-Test-Now=2026-09-21T08:00:00+03:00, POST 'Нагадай 25 вересня о 20:00 оплатити комуналку' from user id U53; a '/export' from U53 shows exactly one reminder with eventAt == '2026-09-25T20:00:00+03:00', and the reflected replies contain a line exactly equal to '25 вересня о 20:00' (four days out, so the date form; no year, because it is the current year)"
  - id: date-form-other-year
    assert: "With X-Test-Now=2026-12-30T08:00:00+02:00, POST 'Нагадай 5 січня о 8:00 подати показники' from user id U54; a '/export' from U54 shows exactly one reminder with eventAt == '2027-01-05T08:00:00+02:00', and the reflected replies contain a line exactly equal to '5 січня 2027 о 8:00' (the year is shown because it differs from the year of 'now')"
  - id: delivery-message
    assert: "With X-Test-Now=2026-09-21T08:00:00+03:00, POST 'Нагадай сьогодні о 20:00 забрати посилку' from user id U55; then POST /sweep (valid X-Sweep-Secret) with X-Test-Now=2026-09-21T19:45:00+03:00; the reflected replies contain exactly one delivery whose first line starts with 'Нагадування: ' and whose second line is exactly 'Сьогодні о 20:00'; that delivery contains neither 'Reminder:' nor 'when:'"
  - id: snooze-toast-humanised
    assert: "Continuing from delivery-message: read U55's notification id from a '/export', then POST a callback_query update from U55 with data 'rem:tmrw:<notificationId>' and X-Test-Now=2026-09-21T19:45:00+03:00; the reflected replies contain exactly the string 'Нагадаю ще раз завтра о 9:00.' and no ISO timestamp"
  - id: recurrence-humanised
    assert: "With X-Test-Now=2026-09-21T10:00:00+03:00 (Monday, Europe/Kyiv), POST 'Винось сміття щопонеділка о 8:00' from user id U56; a '/export' from U56 shows exactly one reminder with a weekly recurrence on monday and one scheduled notification at '2026-09-28T08:00:00+03:00'; the reflected replies contain a line exactly equal to '28 вересня о 8:00' and a line exactly equal to 'Повторюється: щопонеділка о 8:00'"
  - id: unresolvable-value-passed-through
    assert: "With X-Test-Now=2026-09-21T08:00:00+03:00, POST 'Нагадай колись розібрати гараж' from user id U57 (no resolvable time); a '/export' from U57 shows reminders == []; the reflected replies contain no line matching /^(Сьогодні|Завтра|Післязавтра)\\b/ - a missing or unresolvable time is never rendered as a relative day"
failures: []
---

# 0008 - Human-readable Ukrainian times in reminder replies

## Context

A delivered reminder currently reads:

```
Reminder: Здавати аналізи ЕКГ, кардіограми і УЗД. Не їсти, не пити каву.
when: 2026-09-21T11:00:00+03:00
```

The `when:` line is a raw canonical `eventAt` - the storage form
([event-at.ts](../../src/reminders/event-at.ts)) leaking straight into the chat. It is precise and
unreadable: a person cannot tell at a glance that this is *today at 11*, which is the only thing the
message needs to convey.

This spec replaces every raw timestamp in the **reminder** replies with a Ukrainian phrase relative
to "now" - `Сьогодні о 20:00`, `Завтра об 11:00`, `Післязавтра о 9:30`, and a plain date beyond that
(`25 вересня о 20:00`). The rest of the bot's copy stays English; see **Out of scope**.

The timezone needed to decide "today" is already settled: `DEFAULT_TIMEZONE=Europe/Kyiv`
([cloudbuild.yaml:46](../../cloudbuild.yaml#L46)), and every stored `eventAt` already carries its own
offset, which is what this change reads the calendar day in.

## Scope

- `src/reminders/humanize-time.ts` - **new.** The whole of the formatting, with no Nest, no config
  and no clock dependency, so it is a pure function a unit test can pin.
- `src/reminders/recurrence.ts` - `describeRecurrence` only, rewritten to Ukrainian on top of the
  new helper. Nothing else in this file moves; the validation and `nextOccurrence` are untouched.
- `src/telegram/telegram.service.ts` - the four sites that print a timestamp or an English reminder
  label, plus the signature changes needed to give them "now" (below).
- `src/telegram/sweeper.service.ts` - the `sendReminder` call site only, to pass `now`.
- `test/humanize-time.spec.ts` - **new.**
- `test/recurrence.spec.ts`, `test/telegram.service.spec.ts`, `test/telegram.callback.spec.ts`,
  `test/sweeper.service.spec.ts` - updated for the new strings and signatures.
- `CLAUDE.md` - one new paragraph in **Architecture**, so the rule survives this spec. Exact text in
  **Contracts**; nothing else in that file changes.

## Contracts

### `src/reminders/humanize-time.ts`

```ts
/**
 * An ISO instant rendered as a Ukrainian phrase relative to `now`:
 * 'Сьогодні о 20:00' | 'Завтра об 11:00' | 'Післязавтра о 9:30' | '25 вересня о 20:00'
 * | '5 січня 2027 о 8:00'
 */
export function humanizeInstant(
  iso: string,
  now: Date,
  options?: { capitalize?: boolean },
): string;

/** 'HH:mm' (or 'H:mm') wall-clock -> 'о 20:00' | 'об 11:00'. */
export function humanizeTimeOfDay(atLocal: string): string;
```

Rules, all normative:

1. **The calendar day is read in the value's own offset.** `iso` is parsed with
   `DateTime.fromISO(iso, { setZone: true })` and `now` is converted into that same zone before the
   two `startOf('day')` values are compared. The stored offset is the zone the user meant; the
   server's zone is never used, and `DEFAULT_TIMEZONE` is deliberately not plumbed in here.
2. **Day difference decides the prefix:** `0 -> 'Сьогодні'`, `1 -> 'Завтра'`, `2 -> 'Післязавтра'`,
   anything else (including a **negative** difference, i.e. a late delivery) -> the date form. There
   is no `Вчора` branch.
3. **Date form:** `'<d> <місяць у родовому відмінку>'`, e.g. `25 вересня`. The year is appended,
   before the time, **only** when the target's year differs from the year of `now` in that same
   zone: `5 січня 2027 о 8:00`.
4. **Time:** `H:mm` - hour with no leading zero, minutes always two digits. `20:00`, `9:30`, `8:00`.
5. **Preposition:** `об` when the hour is `11`, otherwise `о`. (`об одинадцятій`, but
   `о двадцятій`.) Applies in `humanizeInstant` and `humanizeTimeOfDay` alike.
6. **Assembly:** `'<prefix> <prep> <time>'`, e.g. `Сьогодні о 20:00`, `25 вересня о 20:00`.
7. **`capitalize` defaults to `true`.** With `false` the first character is lower-cased, so the
   phrase can sit inside a sentence (`Нагадаю ще раз завтра о 9:00.`). A date form starts with a
   digit and is unaffected.
8. **Never invent a time.** An empty, unparseable, or offset-less `iso` is returned **unchanged**,
   and `humanizeTimeOfDay` returns its input unchanged when it does not match `^\d{1,2}:\d{2}$`.
   This is the same discipline as `normalizeEventAt`: a value this code cannot resolve is passed
   through, never rendered as `Сьогодні`.

Month names, genitive, index 0-11: `січня, лютого, березня, квітня, травня, червня, липня, серпня,
вересня, жовтня, листопада, грудня`.

### `describeRecurrence` ([recurrence.ts:244](../../src/reminders/recurrence.ts#L244))

Same signature, Ukrainian output, time rendered by `humanizeTimeOfDay`:

| freq | output |
|---|---|
| `daily` | `щодня о 20:00` |
| `weekly` | `щопонеділка о 8:00` |
| `monthly` | `щомісяця 1 числа о 9:00` |
| `yearly` | `щороку 12 червня о 9:00` |

Weekday map: `monday -> щопонеділка`, `tuesday -> щовівторка`, `wednesday -> щосереди`,
`thursday -> щочетверга`, `friday -> щоп'ятниці`, `saturday -> щосуботи`, `sunday -> щонеділі`.

### Reply strings in `telegram.service.ts`

**Delivery** ([telegram.service.ts:315-318](../../src/telegram/telegram.service.ts#L315-L318)) -
the `when:` label disappears entirely, because the phrase already says what it is:

```
Нагадування: <title>
Сьогодні о 20:00
```

**Saved confirmation** ([telegram.service.ts:699](../../src/telegram/telegram.service.ts#L699)):

```
Нагадування збережено: <title>
Завтра об 11:00
Повторюється: щопонеділка о 8:00      <- only when recurring
```

**Unstored preview** ([telegram.service.ts:744-762](../../src/telegram/telegram.service.ts#L744-L762)):

```
Нагадування: <title>
Завтра об 11:00                        <- or: Час не вказано
Нагадати за 30 хв до події             <- or: Час попередження не вказано, я перепитаю
Повторюється: щодня о 20:00            <- only when recurring
```

and the two failure lines appended to it:
`I could not store this reminder right now.` -> `Не вдалося зберегти це нагадування зараз.`;
`I could not work out a clear time, so I did not store it.` ->
`Не зрозумів точний час, тому не зберіг.`

**Callback toasts** ([telegram.service.ts:398-411](../../src/telegram/telegram.service.ts#L398-L411)):
`Done.` -> `Готово.`; `I will remind you again at ${atLocal}.` ->
`Нагадаю ще раз ${humanizeInstant(atLocal, now, { capitalize: false })}.`

**Keyboard** ([telegram.service.ts:115-117](../../src/telegram/telegram.service.ts#L115-L117)):
labels become `Готово` / `+1 год` / `Завтра`. **The `callback_data` values are unchanged** -
`rem:ok:<id>`, `rem:1h:<id>`, `rem:tmrw:<id>` - so already-delivered messages keep working and no
parser changes. The one line of `HELP_TEXT`
([telegram.service.ts:64](../../src/telegram/telegram.service.ts#L64)) that names the old labels is
updated to the new ones; the rest of `HELP_TEXT` stays English.

### Signature changes (`now` has to reach the formatter)

```ts
// telegram.service.ts
async sendReminder(notification: DueNotification, now: Date, sink?: string[]): Promise<void>
private describeItem(item: Classification, result: ClassificationResult, now: Date): string
private describeReminder(item: Classification, now: Date): string
```

`sweeper.service.ts` passes the `now` it already has
([sweeper.service.ts:123](../../src/telegram/sweeper.service.ts#L123)); `route` already holds `now`
and passes it down to `describeItem`. No new clock reads, and nothing calls `new Date()` - a test
pinning `X-Test-Now` must still pin the whole rendering.

### `CLAUDE.md` - the rule has to outlive this spec

A helper only gets reused if the next person (or agent) knows it exists before they write the reply
that would otherwise interpolate an ISO string. So this change adds one paragraph to the
**Architecture** section of [CLAUDE.md](../../CLAUDE.md), immediately after *"Replies are chunked"*,
verbatim:

> **No raw timestamp ever reaches the chat.** Every time the bot shows a user a time it goes through
> `humanizeInstant` / `humanizeTimeOfDay`
> ([src/reminders/humanize-time.ts](src/reminders/humanize-time.ts)), which render an ISO instant as
> `Сьогодні о 20:00` / `Завтра об 11:00` / `25 вересня о 20:00`. Canonical ISO is the **storage**
> form and stays inside Firestore, `/export` and the logs; it is not a thing a person reads. A new
> reply that names a time calls the helper - it never interpolates `eventAt`, `atLocal` or a
> `Date`. The helper is pure and takes `now` as an argument, so nothing in it reads a clock and a
> test that pins `X-Test-Now` still pins the whole rendering. It never invents a time: a value it
> cannot parse is returned unchanged, the same discipline as `normalizeEventAt`.

`docs/architecture.md` is deliberately **not** touched - it is the hand-written planning doc, and
this is a code convention, not a plan.

## Invariants (must not break)

- The webhook always answers `200` except a wrong secret token (`401`); handling failures are
  logged, never returned as `5xx`.
- The `ALLOWED_USERS` gate runs before any voice download or model call, and the "is this an update
  we handle" check runs before the gate.
- Replies set **no `parse_mode`**. This matters more than usual here: the reply embeds the user's own
  words next to Ukrainian text, and an apostrophe in `щоп'ятниці` must stay literal.
- All outbound text keeps going through `sendMessage`, which chunks at 4096 characters.
- Storage is untouched. `eventAt`, `atLocal` and the notification documents keep their canonical ISO
  form - this spec changes **display only**. `/export` output is byte-for-byte what it is today.
- `normalizeEventAt`'s "never invent a time" rule extends to display: an unresolvable value is
  passed through verbatim, never guessed at.
- Health-data discipline: the new code logs nothing at all, and no reminder title or rendered phrase
  is ever logged.

## Acceptance criteria (locked at READY)

- **health:** `GET /` returns HTTP 200 with body `{"status":"ok"}`.
- **auth-401:** POST any update with a wrong `X-Telegram-Bot-Api-Secret-Token` returns HTTP 401.
- **today-form:** With `X-Test-Now=2026-09-21T08:00:00+03:00`, POST *'Нагадай сьогодні о 20:00 випити
  ліки'* from user id U50; a `/export` from U50 shows exactly one reminder with
  `eventAt == '2026-09-21T20:00:00+03:00'`, and the reflected replies for that POST contain a line
  exactly equal to `Сьогодні о 20:00` and a line starting with `Нагадування збережено: `; no
  reflected reply for that POST contains the substring `when:` or the substring `+03:00`.
- **tomorrow-form-ob:** With `X-Test-Now=2026-09-21T08:00:00+03:00`, POST *'Нагадай завтра об 11:00
  здати аналізи'* from user id U51; a `/export` from U51 shows exactly one reminder with
  `eventAt == '2026-09-22T11:00:00+03:00'`, and the reflected replies contain a line exactly equal to
  `Завтра об 11:00` (the preposition is `об`, not `о`, for hour 11).
- **day-after-form:** With `X-Test-Now=2026-09-21T08:00:00+03:00`, POST *'Нагадай післязавтра о 9:30
  подзвонити в клініку'* from user id U52; a `/export` from U52 shows exactly one reminder with
  `eventAt == '2026-09-23T09:30:00+03:00'`, and the reflected replies contain a line exactly equal to
  `Післязавтра о 9:30` (hour has no leading zero, minutes are always two digits).
- **date-form-same-year:** With `X-Test-Now=2026-09-21T08:00:00+03:00`, POST *'Нагадай 25 вересня о
  20:00 оплатити комуналку'* from user id U53; a `/export` from U53 shows exactly one reminder with
  `eventAt == '2026-09-25T20:00:00+03:00'`, and the reflected replies contain a line exactly equal to
  `25 вересня о 20:00` (four days out, so the date form; no year, because it is the current year).
- **date-form-other-year:** With `X-Test-Now=2026-12-30T08:00:00+02:00`, POST *'Нагадай 5 січня о
  8:00 подати показники'* from user id U54; a `/export` from U54 shows exactly one reminder with
  `eventAt == '2027-01-05T08:00:00+02:00'`, and the reflected replies contain a line exactly equal to
  `5 січня 2027 о 8:00` (the year is shown because it differs from the year of "now").
- **delivery-message:** With `X-Test-Now=2026-09-21T08:00:00+03:00`, POST *'Нагадай сьогодні о 20:00
  забрати посилку'* from user id U55; then POST `/sweep` (valid `X-Sweep-Secret`) with
  `X-Test-Now=2026-09-21T19:45:00+03:00`; the reflected replies contain exactly one delivery whose
  first line starts with `Нагадування: ` and whose second line is exactly `Сьогодні о 20:00`; that
  delivery contains neither `Reminder:` nor `when:`.
- **snooze-toast-humanised:** Continuing from **delivery-message**: read U55's notification id from a
  `/export`, then POST a `callback_query` update from U55 with data `rem:tmrw:<notificationId>` and
  `X-Test-Now=2026-09-21T19:45:00+03:00`; the reflected replies contain exactly the string
  `Нагадаю ще раз завтра о 9:00.` and no ISO timestamp.
- **recurrence-humanised:** With `X-Test-Now=2026-09-21T10:00:00+03:00` (Monday, Europe/Kyiv), POST
  *'Винось сміття щопонеділка о 8:00'* from user id U56; a `/export` from U56 shows exactly one
  reminder with a weekly recurrence on `monday` and one scheduled notification at
  `'2026-09-28T08:00:00+03:00'`; the reflected replies contain a line exactly equal to
  `28 вересня о 8:00` and a line exactly equal to `Повторюється: щопонеділка о 8:00`.
- **unresolvable-value-passed-through:** With `X-Test-Now=2026-09-21T08:00:00+03:00`, POST *'Нагадай
  колись розібрати гараж'* from user id U57 (no resolvable time); a `/export` from U57 shows
  `reminders == []`; the reflected replies contain no line matching
  `/^(Сьогодні|Завтра|Післязавтра)\b/` - a missing or unresolvable time is never rendered as a
  relative day.

### Unit tests (not HTTP-assertable, so they live in jest)

The verifier drives the bot over HTTP and cannot read an inline keyboard or exercise a pure
function's edge cases. These are the implementer's responsibility and must be green at
`IMPLEMENTED`:

- `humanizeInstant` across the day boundary: an event at `00:10` rendered from `23:50` the previous
  evening is `Завтра о 0:10`, not `Сьогодні`.
- `humanizeInstant` with a **past** instant returns the date form, never `Вчора` and never
  `Сьогодні` for a different calendar day.
- `humanizeInstant('', now)`, `humanizeInstant('not a date', now)` and
  `humanizeInstant('2026-09-21T11:00:00', now)` (no offset) each return the input unchanged.
- `humanizeInstant` reads the day in the value's own offset: `'2026-09-22T00:30:00+03:00'` from a
  `now` of `2026-09-21T23:00:00+03:00` is `Завтра о 0:30` regardless of the machine's `TZ`.
- `capitalize: false` lower-cases `Завтра` but leaves `25 вересня` untouched.
- `humanizeTimeOfDay` for `'11:00'` -> `об 11:00`, `'08:00'` -> `о 8:00`, `'abc'` -> `abc`.
- `describeRecurrence` for all four frequencies and all seven weekdays.
- `reminderKeyboard` returns labels `Готово` / `+1 год` / `Завтра` with `callback_data` unchanged at
  `rem:ok:<id>` / `rem:1h:<id>` / `rem:tmrw:<id>`.

## Out of scope

- **Localising the rest of the bot.** `/start`, `/help`, `/export`, the `ALLOWED_USERS` refusal, the
  voice guards, the transcription and classifier failure messages, and the symptom / question / note
  / actor / correction descriptions all stay English. Specs
  [0006](0006-actor-capture.md) and [0007](0007-notes-capture.md) are `READY` with acceptance
  criteria written against the current English strings, and this spec must not invalidate them.
- **`NOT_STORED_NOTICE`** ([telegram.service.ts:57](../../src/telegram/telegram.service.ts#L57))
  stays English: it names the non-reminder kinds, which are 0007's subject, and it is removed
  outright once those are stored.
- **Per-user language or timezone.** One user, one language, one `DEFAULT_TIMEZONE`. No `locale`
  field, no negotiation, no `Intl` locale plumbing.
- **A `Вчора` / "N days ago" branch.** Everything outside today/tomorrow/day-after is the date form.
- **Changing what is stored.** No migration, no new field, no change to `eventAt`, `atLocal`, the
  notification documents, or `/export`. Display only.
- **Weekday phrasing for near dates** (`у п'ятницю о 20:00`). The date form covers day 3 onward.
- **The classifier prompt.** It already resolves Ukrainian relative dates; this spec does not touch
  `src/classifier/`.
