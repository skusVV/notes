---
id: 0007-notes-capture
state: IN-TESTING
attempt: 0
max_attempts: 3
branch: feat/0007-notes-capture
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: auth-401
    assert: "POST any update with a wrong X-Telegram-Bot-Api-Secret-Token returns HTTP 401"
  - id: free-thought-stored-without-trigger-word
    assert: "POST 'Thinking I should switch banks, the fees here are ridiculous' (no imperative, no command, no word 'remember') from user id U40; a '/export' from U40 shows notes == [...] containing exactly one item whose originalText contains 'banks', whose intent == 'note', and whose summary is a non-empty string"
  - id: off-topic-still-stored
    assert: "POST 'What is the weather going to be like tomorrow' from user id U41; a '/export' from U41 shows notes containing exactly one item whose intent == 'other' and whose originalText contains 'weather'"
  - id: reminder-not-double-stored
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Remind me to call the doctor tomorrow at 10am' from user id U42; a '/export' from U42 shows exactly one reminder and notes == []"
  - id: export-empty-shape
    assert: "A '/export' command update from a user id with nothing stored (U43) returns a reflected reply that parses as JSON exactly equal to {\"reminders\":[],\"actors\":[],\"notes\":[]}"
failures: []
---

# 0007 - Notes: capture and store stray thoughts

## Context

Today `note` and `other` are already real branches of the classifier's output - `note` is even
documented in its own prompt as *"a thought, fact or observation to remember. The default for
anything worth keeping"* ([classifier.service.ts:225](../../src/classifier/classifier.service.ts#L225))
- but neither one persists anything. `describeItem` just composes a reply and throws the
classification away
([telegram.service.ts:736-740](../../src/telegram/telegram.service.ts#L736-L740)). The `other` case
even says *"I would keep it as a plain note"* without doing it - a small lie in the current reply.

This spec makes that already-designed promise real: a message that is not a reminder, symptom,
question, correction, or fact about a person gets written to a `notes` store, exactly as
[architecture.md](../architecture.md) describes it - `note`: *"entry only, embedded and tagged"*
([architecture.md:100](../architecture.md#L100)), and `other` *degrading* to a note rather than being
dropped ([architecture.md:139](../architecture.md#L139)) or, when it is confidently outside the bot's
scope entirely (its own example: *"What's the weather tomorrow"*), still stored, never silently
swallowed ([architecture.md:149](../architecture.md#L149)). The embedding/tagging half of that
sentence is retrieval (architecture.md section 7) and is explicitly not this spec - see Out of scope.

**No trigger word, no command.** This is the point of building it on the classifier rather than on a
keyword: "Thinking I should switch banks, the fees here are ridiculous" is not phrased as an
instruction and never says "remember" or "note that", yet it is exactly the kind of stray thought
`note` already exists to catch. Nothing about capture depends on how the sentence is phrased - only on
what the classifier decides it *is*. Storing it is this spec's only job.

## Scope

The implementer may touch only these:

- `src/notes/` (new) - `NotesService.create(...)` and `NotesService.list(userId)`, backed by
  Firestore at `users/{userId}/notes/{autoId}`, mirroring `RemindersService`'s shape and degrade
  pattern ([reminders.service.ts:106-109](../../src/reminders/reminders.service.ts#L106-L109)).
  `notes.module.ts` imports `FirestoreModule`, same as `reminders.module.ts`.
- `src/telegram/telegram.service.ts` - a new `handleNote(...)` method, parallel to `handleReminder`
  ([telegram.service.ts:653-711](../../src/telegram/telegram.service.ts#L653-L711)); the dispatch loop
  in `route` gains a branch for `intent === 'note' || intent === 'other'` alongside the existing
  `reminder` branch ([telegram.service.ts:624-635](../../src/telegram/telegram.service.ts#L624-L635));
  `handleExport` gains a `notes` key; `HELP_TEXT` and `NOT_STORED_NOTICE` wording updated to reflect
  that notes are now stored (see Invariants).
- `src/telegram/telegram.module.ts`, `src/app.module.ts` - wire `NotesModule`.
- `test/` - unit tests, if any pure logic is worth isolating (see Acceptance; this slice may not need
  any beyond what the acceptance criteria already cover over HTTP).

Out of bounds without returning to `DRAFT`: `cloudbuild.yaml`, the classifier (the `note`/`other`
schema and prompt already exist and need no change), the `reminder`, `symptom`, `question`,
`actor_info`, and `correction` branches, retrieval/embeddings, and anything below `CONFIDENCE_ASK`
(the existing clarify branch is unchanged - see Invariants).

If [0006-actor-capture](0006-actor-capture.md) has already landed by the time this is implemented,
`/export` will already carry an `actors` key; add `notes` as a third key alongside it rather than the
two-key shape shown below, which reflects today's baseline (0006 is still `DRAFT`).

## Contracts

**`NotesService`** (`src/notes/notes.service.ts`), Firestore-backed, degrades like `RemindersService`
when unavailable (`available` false, no throw on construction when `GCP_PROJECT` is unset):

- `create(userId, chatId, originalText, summary, intent, now): Promise<string | undefined>` - writes
  `users/{userId}/notes/{autoId}`: `{ userId, chatId, originalText, summary, intent, createdAt:
  Timestamp }`. `intent` is the literal classified value, `'note'` or `'other'` - kept distinct
  rather than collapsed, because the `other` rate is itself a signal the taxonomy needs a new intent
  ([architecture.md:161](../architecture.md#L161)). Returns the new document's id, or `undefined` when
  the store is unavailable (no write attempted). Unlike reminders, there is no rejection path for a
  well-formed note - `eventAt` can fail to resolve, but a note is just the classifier's own summary of
  text that already exists, so nothing here is invented or validated away.
- `list(userId): Promise<NoteExport[]>` - reads that user's notes ordered by `createdAt` ascending.
  `NoteExport` is `{ id, originalText, summary, intent, createdAt }`, `createdAt` serialised as an ISO
  string, same convention as `ReminderExport`
  ([reminders.service.ts:36-54](../../src/reminders/reminders.service.ts#L36-L54)).

No TTL, no `expireAt` field. Reminders expire because the event they describe passes; a note has no
such horizon and is meant to be kept indefinitely - it is the bot's memory, not a queue. No new
Firestore Console setup is needed as a result (unlike 0002 and 0006, which each added a TTL policy).

**`handleNote(item, from, chatId, originalText, now, sender): Promise<{ text: string; stored: boolean
}>`.** Called from `route` for any item with `intent === 'note'` or `intent === 'other'` that is
already at or above `CONFIDENCE_ASK` (the loop's existing gate - unchanged, see Invariants).

- When `from` is present and `this.notes.available`: call `NotesService.create` with `item.summary`
  and `item.intent`; on success (`id` returned) reply text is `` `Note saved: ${item.summary}` `` for
  `intent === 'note'`, or `` `Not sure what that was, so I kept it as a note: ${item.summary}` `` for
  `intent === 'other'` - both run through the existing `withConfidence` wrapper
  ([telegram.service.ts:809-814](../../src/telegram/telegram.service.ts#L809-L814)) so the
  middle confidence band still shows its number, matching every other branch. `stored: true`.
- When `from` is absent, `notes` is unavailable, or `create` throws: reply text is the existing
  `describeItem(item, result)` wording (unchanged - it already reads correctly as a preview, not a
  confirmation) with `` `\nI could not store this note right now.` `` appended, matching
  `handleReminder`'s degrade wording
  ([telegram.service.ts:669](../../src/telegram/telegram.service.ts#L669)). `stored: false`. A
  `create` failure is logged, never thrown up to the webhook.

**`/export` command.** Gains a `notes` key: `{"reminders": [...], "notes": [...]}` (or a third key
alongside `actors` if 0006 has landed - see Scope), each note as
`{ id, originalText, summary, intent, createdAt }`. Still scoped to the requesting user only, still no
`parse_mode`.

**`HELP_TEXT`** ([telegram.service.ts:59-68](../../src/telegram/telegram.service.ts#L59-L68)) - update
`'Reminders with a clear date and time are saved; other kinds are not kept yet.'` to state that notes
are saved too, and the `/export` line to mention notes. Wording is not asserted by acceptance criteria
(see README's rule that model-driven behavior is asserted on stored structure, never wording).

**`NOT_STORED_NOTICE`** ([telegram.service.ts:54-57](../../src/telegram/telegram.service.ts#L54-L57))
- update the text so it no longer claims only reminders are stored; it still applies whenever a reply
acted on something that was *not* stored (`symptom`, `question`, `actor_info`, `correction`, or a
`note`/`other` that failed to store because the service was unavailable).

## Invariants (must not break)

- The webhook still answers `200` for every handled update and `401` only on a wrong secret token; a
  `NotesService` failure is caught and logged, never returned as `5xx`.
- The `ALLOWED_USERS` gate and the classifier call are both unchanged - this spec only adds a branch
  after classification already happened.
- An item below `CONFIDENCE_ASK` is never stored - the existing clarify branch
  ([telegram.service.ts:617-622](../../src/telegram/telegram.service.ts#L617-L622)) is untouched, so
  an ambiguous message still gets asked about instead of being filed as a note.
- A `reminder` item is never also written to `notes` - the two branches are mutually exclusive per
  item (see `reminder-not-double-stored`).
- Replies set no `parse_mode` - a note's `summary` and `originalText` embed the user's own words.
- Health-data discipline: never log `originalText` or `summary`, on store or on export - the existing
  "log ids and counts, not content" rule (mirrors
  [0002-reminders-capture.md:167](0002-reminders-capture.md#L167)).
- `NotesService` must not throw on construction when `GCP_PROJECT` is unset; it degrades the same way
  `RemindersService`, `ActorsService`, `TranscriptionService`, and `ClassifierService` already do.

## Acceptance criteria (locked)

Mirrored in the frontmatter `acceptance`. The verifier drives the test function (reply reflection on,
`test` Firestore database) and asserts on stored structure via `/export`, never on reply wording. Each
criterion uses a distinct `from.id` so stored notes/reminders do not bleed between tests.

- **health / auth-401** - carried over, prove the function and auth path on the test deploy.
- **free-thought-stored-without-trigger-word** - a stray observation with no imperative phrasing and
  no trigger word is still classified as `note` and stored, proving capture depends on what the
  classifier decides, not on how the sentence is phrased.
- **off-topic-still-stored** - architecture's own canonical `other` example ("What's the weather
  tomorrow") is stored with `intent == 'other'`, not silently dropped.
- **reminder-not-double-stored** - a clear reminder message writes a reminder and nothing to `notes`.
- **export-empty-shape** - `/export` with nothing stored returns exactly `{"reminders":[],"actors":[],"notes":[]}`
  (three keys, because 0006-actor-capture has landed - see Scope).

No new deterministic parsing logic is introduced here (unlike `event-at.ts` / `notify-times.ts` /
`recurrence.ts` for reminders, or the decline-phrase matcher for actors) - `NotesService` is a thin
Firestore wrapper around fields the classifier already produces, so it is covered by the acceptance
criteria above rather than a separate unit-test fixture.

## Out of scope

- **Retrieval.** No embeddings, no `/recall`, no semantic or keyword search over notes. Architecture
  section 7 is a later spec; this one only makes notes exist to search later.
- **Tags and keywords on the note.** The classifier already returns `result.keywords[]` and
  `result.mentions[]`, but attaching them to the stored note is part of retrieval, not capture.
- **The generic `entries` capture log (phase 0).** Still not built. This spec adds one more narrow
  projection (`notes`), the same shape of slice `reminders` and (planned) `actors` already are.
- **Editing or deleting a stored note.**
- **Any change to the classifier.** The `note`/`other` intents, their schema, and their prompt wording
  already exist and are unchanged by this spec.
- **Any change to the `reminder`, `symptom`, `question`, `actor_info`, or `correction` branches**, or
  to the ask/clarify behavior for items below `CONFIDENCE_ASK`.
- **Mention detection inside notes.** 0006's ask-about-a-new-person flow is scoped to the `reminder`
  branch only and is not extended here.
- **Pagination or a cap on `/export`.** Mirrors reminders and actors, neither of which has one either.
