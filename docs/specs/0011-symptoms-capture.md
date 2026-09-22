---
id: 0011-symptoms-capture
state: IN-TESTING
attempt: 1
max_attempts: 3
branch: feat/0011-symptoms-capture
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: auth-401
    assert: "POST any update with a wrong X-Telegram-Bot-Api-Secret-Token returns HTTP 401"
  - id: present-tense-started-now
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'болить голова' from user id U50; a '/export' from U50 shows symptoms containing exactly one item whose type == 'headache', whose severity is null, and whose startedAt is a non-empty ISO string that parses to the same calendar day (Europe/Kyiv) as X-Test-Now"
  - id: severity-never-invented
    assert: "POST 'дуже сильно болить голова' from user id U51; a '/export' from U51 shows symptoms containing exactly one item whose type == 'headache' and whose severity is null (the intensity word is not turned into a number)"
  - id: severity-stored-when-numeric
    assert: "POST 'болить голова, десь на 7 з 10' from user id U52; a '/export' from U52 shows symptoms containing exactly one item whose type == 'headache' and whose severity == 7"
  - id: past-symptom-started-resolved
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'вчора ввечері боліла голова' from user id U53; a '/export' from U53 shows symptoms containing exactly one item whose startedAt is a non-empty ISO string that parses to 2026-09-15 (Europe/Kyiv), the day before X-Test-Now"
  - id: same-symptom-same-slug
    assert: "From user id U54, POST 'болить голова' then POST 'знову розколюється голова'; a '/export' from U54 shows exactly two symptoms whose type values are both non-empty and equal to each other"
  - id: symptom-and-reminder-split
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'болить голова, нагадай випити таблетку о 18:00' from user id U55; a '/export' from U55 shows exactly one symptom whose type == 'headache' and exactly one reminder"
  - id: export-has-symptoms-key
    assert: "A '/export' command update from a user id with nothing stored (U56) returns a reflected reply that parses as JSON whose 'symptoms' property deep-equals []"
failures:
  - attempt: 0
    stage: verification
    detail: >-
      Verified against the live test deploy of feat/0011-symptoms-capture (code at 17b8768) on the
      telegram-echo-bot-test function, test Firestore database, asserting on /export structure. 8 of 9
      criteria PASS: health (200 {"status":"ok"}), auth-401 (401 on a wrong X-Telegram-Bot-Api-Secret-Token,
      200 on a valid one), present-tense-started-now ("болить голова" -> one symptom type=headache,
      severity=null, startedAt=2026-09-16T09:00:00+03:00 = X-Test-Now day), severity-never-invented
      ("дуже сильно болить голова" -> severity=null), severity-stored-when-numeric ("...на 7 з 10" ->
      severity=7), same-symptom-same-slug ("болить голова" + "знову розколюється голова" -> two symptoms
      both type=headache), symptom-and-reminder-split (one new symptom type=headache AND exactly one new
      reminder, notes/actors unchanged - asserted as a before/after delta because every allowlisted test
      user id carries seed reminders from prior specs, so an absolute "reminders length == 1" is not
      achievable in this shared test DB), export-has-symptoms-key (/export exposes "symptoms":[]).
      FAILED: past-symptom-started-resolved. With X-Test-Now=2026-09-16T09:00:00+03:00, "вчора ввечері
      боліла голова" from a fresh user stored startedAt=2025-09-15T19:00:00+03:00 - the correct month/day
      (the day before X-Test-Now) but the WRONG YEAR, 2025 instead of 2026, so it parses to 2025-09-15
      not the required 2026-09-15. This is intermittent model nondeterminism at temperature 0, not a
      deterministic code defect: on repeated retries the exact phrase resolved to 2026-09-15 eight times,
      to 2025-09-15 once (the authoritative run), and once was not classified as a symptom at all; the
      English "yesterday evening my head hurt" returned 2025 twice then 2026 six times. The implementer's
      classifier "Symptoms" prompt block is faithful and already carries the correct worked example
      (now=2026-09-16 -> startedAt=2026-09-15 evening), so the model, not the prompt text, drifts the year.
      Actionable, in-scope (prompt-only) lever: add an explicit year anchor to the startedAt rule, e.g.
      "keep the current year unless the message names a different one; 'yesterday'/'вчора' never crosses
      into a previous year". Alternatively the humans may relax the locked criterion to assert the
      month-day component only (its own parenthetical already says "asserting the date component only"),
      which would require returning the spec to READY. Security checklist over git diff main...feat/0011:
      PASS overall (A access-gate: listKnownTypes/handleSymptom run after the ALLOWED_USERS gate, no new
      pre-gate paid path; B auth/200 contract intact, reflection still behind TEST_REFLECT_REPLY, symptom
      create failure caught not 5xx; C voice caps untouched, no unbounded model spend; D model output
      stays confined to the symptom branch, no eval/shell; E no new secret, none logged/committed; F
      health-data discipline holds - symptom type/severity/startedAt/notes/originalText never logged,
      only ids and counts; G scope respected - classifier change is prompt-only, cloudbuild.yaml and the
      schema/coerce/clamp logic untouched). testing was reset to main and force-pushed; .testing-lock
      cleared. attempt incremented 0 -> 1 (one rework attempt consumed).
---

# 0011 - Symptoms: capture and store health events

## Context

Today `symptom` is a real branch of the classifier's output - the intent exists, its `SymptomDraft`
is fully extracted (`type`, `severity`, `startedAt`, `durationMinutes`, `notes`,
[classifier.types.ts:45-53](../../src/classifier/classifier.types.ts#L45-L53)), the payload is
already defended (severity clamped, a typeless symptom forced below the ask-threshold,
[classifier.service.ts:536-543](../../src/classifier/classifier.service.ts#L536-L543)) - but nothing
persists. `describeSymptom` only composes a preview and throws the classification away
([telegram.service.ts:999-1019](../../src/telegram/telegram.service.ts#L999-L1019)).

This spec makes symptom capture real, exactly as [architecture.md](../architecture.md) phase 3
describes it: `symptom` -> the `symptoms` projection ([architecture.md:101](../architecture.md#L101)),
`type` a normalized slug, `severity` **null when not stated and never inferred**, `startedAt` and
`durationMinutes` where stated, the user's own words kept verbatim
([architecture.md:251-260](../architecture.md#L251-L260)). It is the same thin
capture-classify-confirm-store slice that [0007-notes-capture](0007-notes-capture.md) is for notes,
plus two things notes did not need: structured fields, and the symptom-vocabulary wiring that makes
counting the same symptom across wordings possible at all.

**Why the vocabulary wiring is in scope, not deferred.** The point of tracking symptoms here is not a
report to hand a doctor - it is a **signal layer**: the bot accumulates entries so that a *later*
feature can notice a tendency and tell the user ("your headaches have clustered lately - worth
checking"). Noticing "often the same symptom" is impossible unless "болить голова", "headache" and
"my head is splitting" all land on **one** slug. The classifier's prompt side is already wired to a
known-vocabulary list ([classifier.service.ts:406-411](../../src/classifier/classifier.service.ts#L406-L411));
it is simply fed an empty array today
([telegram.service.ts:731](../../src/telegram/telegram.service.ts#L731)). This spec feeds it. That is
[architecture.md](../architecture.md)'s "hidden hard part"
([architecture.md:278-288](../architecture.md#L278-L288)): skip it and aggregation silently never
works, and the bug only appears the day someone asks a counting question.

**The insight / pattern-noticing feature is the motivating goal but is NOT built here** - it needs
history and aggregation (phase 4). See Out of scope. v1's only job is to capture symptoms cleanly
enough that the signal layer can be built on top of them later.

## Scope

The implementer may touch only these:

- `src/symptoms/` (new) - `SymptomsService` backed by Firestore at
  `users/{userId}/symptoms/{autoId}`, mirroring `RemindersService`'s and (planned) `NotesService`'s
  shape and degrade pattern ([reminders.service.ts:102-197](../../src/reminders/reminders.service.ts#L102-L197)).
  `symptoms.module.ts` imports `FirestoreModule`, same as `reminders.module.ts`.
- `src/classifier/classifier.service.ts` - **prompt only**: add a "Symptoms" block to
  `buildInstruction` (the `startedAt` resolution rule and the never-infer-severity rule, below). The
  `RESPONSE_SCHEMA`, `coerceItem`/`parse`, `clampSeverity`, and the existing "a symptom with no
  `type` drops below `CONFIDENCE_ASK`" logic are **unchanged** - the fields and their defences
  already exist.
- `src/telegram/telegram.service.ts` - a `handleSymptom(...)` method parallel to `handleReminder`
  ([telegram.service.ts:653-711 region](../../src/telegram/telegram.service.ts#L653)); a `symptom`
  branch in the `route` dispatch loop
  ([telegram.service.ts:762-781](../../src/telegram/telegram.service.ts#L762-L781)) alongside the
  `reminder` branch; `knownSymptomTypes` populated from `SymptomsService.listKnownTypes` instead of
  the hardcoded `[]` ([telegram.service.ts:731](../../src/telegram/telegram.service.ts#L731));
  `handleExport` gains a `symptoms` key
  ([telegram.service.ts:589-617](../../src/telegram/telegram.service.ts#L589-L617)); `HELP_TEXT` and
  `NOT_STORED_NOTICE` wording updated to reflect that symptoms are now stored (see Contracts).
- `src/telegram/telegram.module.ts`, `src/app.module.ts` - wire `SymptomsModule`.
- `test/` - unit tests only if pure logic is worth isolating (see Acceptance; this slice likely needs
  none beyond the HTTP criteria, as `SymptomsService` is a thin Firestore wrapper).

Out of bounds without returning to `DRAFT`: `cloudbuild.yaml`; the classifier schema, `coerceItem`,
and the confidence-forcing logic; the `reminder`, `note`, `other`, `question`, `actor_info`, and
`correction` branches; the ask/clarify behavior below `CONFIDENCE_ASK`; retrieval/embeddings; any
insight or pattern-detection logic; a `/symptoms` command; attributing a symptom to a person.

**Baseline note.** At the time of writing, `/export` carries `reminders` and `actors` (0006 is DONE);
[0007-notes-capture](0007-notes-capture.md) adds a `notes` key and is `READY` but not yet landed. Add
`symptoms` as one more key alongside whichever keys exist when this is implemented - do not assume the
exact set, only that `symptoms` must be present and correct.

## Contracts

**`SymptomDraftInput`** - the part of a classified symptom the store needs (the implementer may reuse
`SymptomDraft` directly if convenient):

```
{ type: string; severity?: number; startedAt?: string; durationMinutes?: number; notes?: string }
```

**`SymptomsService`** (`src/symptoms/symptoms.service.ts`), Firestore-backed, degrades exactly like
`RemindersService`/`ActorsService` (`available` reflects the provider; no throw on construction when
`GCP_PROJECT` is unset; reads return empty and `create` returns `undefined` when the store is
unavailable):

- `create(userId, chatId, draft: SymptomDraftInput, originalText, now: Date): Promise<string | undefined>`
  - writes `users/{userId}/symptoms/{autoId}`:
  `{ userId, chatId, originalText, type, severity?, startedAt?, durationMinutes?, notes?, createdAt: Timestamp }`.
  **Absent stays absent** - `severity`, `startedAt`, `durationMinutes` and `notes` are written only
  when the draft carries them; a missing field is never defaulted to `0`, `null`, or an empty string
  in the document (absence is the meaningful state, per
  [architecture.md:257](../architecture.md#L257)). Returns the new document id, or `undefined` when
  the store is unavailable (no write). There is **no rejection path** for a well-formed symptom: a
  typeless symptom never reaches here (the classifier forced it below `CONFIDENCE_ASK`), and every
  other field is optional, so nothing is validated away.
- `list(userId): Promise<SymptomExport[]>` - that user's symptoms ordered by `createdAt` ascending
  (`createdAt` is always present; `startedAt` may not be, so it is not the sort key). Empty when the
  store is unavailable.
- `listKnownTypes(userId): Promise<string[]>` - the **distinct** `type` slugs this user has stored,
  for `ClassifierContext.knownSymptomTypes`. Empty when the store is unavailable. This is the read
  that stops the model minting a new slug per wording.

`SymptomExport` is `{ id, originalText, type, severity, startedAt, durationMinutes, notes, createdAt }`:

- `severity`: `number | null` - `null` when absent, so a reader can tell "not stated" from a real
  value ([architecture.md:257](../architecture.md#L257)).
- `startedAt`: `string | null` - the classifier's ISO-8601-with-offset string, or `null` when absent.
- `durationMinutes`: `number | null`.
- `notes`: `string` - the user's own free-text description, or `''` when absent.
- `createdAt`: ISO string, same convention as `ReminderExport`
  ([reminders.service.ts:36-54](../../src/reminders/reminders.service.ts#L36-L54)).

No TTL, no `expireAt` field. A symptom has no horizon after which it stops mattering - it is the
signal layer's raw material and is kept indefinitely, exactly like a note and unlike a reminder. **No
new Firestore Console setup** is required as a result.

**Classifier prompt - the "Symptoms" block** (`buildInstruction`, prompt text only). State these as
explicit rules with an example, not as behavior hoped for from the general instructions:

- Resolve `startedAt` against the current local time already given in the prompt. When the message
  states when the symptom began ("з понеділка", "вчора ввечері", "2 години тому"), emit `startedAt`
  as ISO 8601 with the user's local offset.
- When the symptom is described in the **present tense** with no stated start ("болить голова", "my
  head hurts"), set `startedAt` to **now** (the current local time). This is the one deliberate,
  narrow inference allowed here: a present-tense symptom is happening now. It is defensible in a way
  severity is not, because it does not invent a measurement.
- When the message is about a past symptom but gives no resolvable time, **omit** `startedAt`.
- **Never infer `severity`.** Emit it only when the user states a number ("на 7 з 10", "severity 7").
  An intensity word - "дуже", "сильно", "bad", "terrible" - is **not** a number and must leave
  `severity` absent. One fabricated 7 pollutes every later average
  ([architecture.md:521-524 region](../architecture.md#L520)).
- `durationMinutes` only when the user states how long it lasted; `type` remains an English
  snake_case slug, reusing a known slug when one fits (the known-slug list is already appended to the
  prompt when non-empty).

**`knownSymptomTypes` wiring** (`telegram.service.ts`). In `route`, replace the hardcoded
`knownSymptomTypes: []` with the distinct slugs read via `SymptomsService.listKnownTypes(from.id)`,
guarded like `actorContext` is: only when `from` is present and `symptoms.available`, wrapped so a
read failure logs and falls back to `[]` rather than throwing (the classifier call must never be
blocked by a vocabulary read).

**`handleSymptom(item, from, chatId, originalText, now, sender): Promise<{ text: string; stored: boolean }>`.**
Called from `route` for any item with `intent === 'symptom'` already at or above `CONFIDENCE_ASK`
(the loop's existing gate - unchanged):

- When `from` is present, `this.symptoms.available`, and `item.symptom` is present: call
  `SymptomsService.create`; on success (`id` returned) the reply is the `describeSymptom(item)`
  detail block prefixed to read as a confirmation (e.g. `Logged symptom:` in place of `Symptom:`),
  run through the existing `withConfidence` wrapper so the middle confidence band still shows its
  number. `stored: true`.
- When `from` is absent, `symptoms` is unavailable, `item.symptom` is missing, or `create` throws:
  the reply is the existing `describeSymptom(item)` preview with `` `\nI could not store this symptom right now.` ``
  appended, matching `handleReminder`'s degrade wording. `stored: false`. A `create` failure is
  logged (ids/counts only), never thrown up to the webhook.

**`route` dispatch.** Add, alongside the `reminder` branch: `if (item.intent === 'symptom')` ->
`handleSymptom`, push its text, and set `hasUnstored = true` only when `outcome.stored` is false
(same shape as the reminder branch). A `symptom` item must not also fall through to `describeItem`.

**`/export`.** Gains a `symptoms` key carrying `SymptomExport[]` for the requesting user, alongside
the existing keys. Still scoped to the requesting user, still no `parse_mode`.

**`HELP_TEXT` / `NOT_STORED_NOTICE`** ([telegram.service.ts:55-69](../../src/telegram/telegram.service.ts#L55-L69))
- update both so they no longer imply only reminders are stored: `HELP_TEXT` states that symptoms are
  saved too (and, if 0007 has landed, notes); `NOT_STORED_NOTICE` still applies whenever a reply acted
  on something that was *not* stored (`question`, `actor_info`, `correction`, or a `symptom` that
  failed to store because the service was unavailable). Wording is not asserted by acceptance criteria.

## Invariants (must not break)

- The webhook still answers `200` for every handled update and `401` only on a wrong secret token; a
  `SymptomsService` failure is caught and logged, never returned as `5xx`.
- The `ALLOWED_USERS` gate runs before the classifier call; the `listKnownTypes` read is part of
  building the classifier context and must not run before the gate, and its failure must not block
  classification.
- An item below `CONFIDENCE_ASK` is never stored - the existing clarify branch
  ([telegram.service.ts:762-768](../../src/telegram/telegram.service.ts#L762-L768)) is untouched, and
  the classifier's "a symptom with no `type` is forced below `CONFIDENCE_ASK`"
  ([classifier.service.ts:579](../../src/classifier/classifier.service.ts#L579)) still stands, so a
  typeless or ambiguous symptom is asked about, never filed.
- `severity` is **never** inferred: stored only when the user stated a number, `null` otherwise.
  `startedAt = now` is allowed **only** for a present-tense symptom, never fabricated for a
  past-tense symptom with no stated time.
- A `symptom` item is never also written to `reminders` or `notes` - the per-item branches are
  mutually exclusive (see `symptom-and-reminder-split`).
- Replies set no `parse_mode` - a symptom's `type`, `notes` and `originalText` embed the user's own
  words, including a stray underscore.
- Health-data discipline: symptoms are health information. Never log `type`, `notes`, `startedAt`,
  `severity`, or `originalText` - only ids and counts, the existing rule
  (mirrors [0002-reminders-capture.md:167](0002-reminders-capture.md#L167) and
  [reminders.service.ts:192-195](../../src/reminders/reminders.service.ts#L192-L195)).
- `SymptomsService` must not throw on construction when `GCP_PROJECT` is unset; it degrades exactly as
  `RemindersService`, `ActorsService`, `ClassifierService`, and `TranscriptionService` already do.

## Acceptance criteria (locked)

Mirrored in the frontmatter `acceptance`. The verifier drives the test function (reply reflection on,
`test` Firestore database) and asserts on stored structure via `/export`, never on reply wording.
Each criterion uses a distinct `from.id` so stored records do not bleed between tests. Slug assertions
(`type == 'headache'`) trust the classifier at `temperature: 0` to slug an unambiguous symptom
consistently, the same way [0007-notes-capture](0007-notes-capture.md) trusts it to return `note`.

- **health / auth-401** - carried over, prove the function and auth path on the test deploy.
- **present-tense-started-now** - a present-tense symptom is stored with `startedAt = now` and
  `severity == null`, proving both the Variant-A present-tense rule and that no severity is invented.
- **severity-never-invented** - an intensity word ("дуже сильно") does **not** become a number;
  `severity` stays `null`.
- **severity-stored-when-numeric** - an explicit "7 з 10" **is** stored as `severity == 7`.
- **past-symptom-started-resolved** - "вчора ввечері" resolves `startedAt` to the day before
  `X-Test-Now`, proving the Variant-A past-time resolution (asserting the date component only; the
  hour is model-chosen).
- **same-symptom-same-slug** - two differently-worded reports of the same symptom from one user land
  on the **same** non-empty `type` slug, the observable guarantee that the vocabulary wiring provides
  and the one that makes future "how often" counting possible.
- **symptom-and-reminder-split** - a multi-intent message writes exactly one symptom and exactly one
  reminder, and nothing is double-stored.
- **export-has-symptoms-key** - `/export` with nothing stored exposes `symptoms: []`.

No new deterministic parsing module is introduced (unlike `event-at.ts` for reminders), so no separate
unit-test fixture is required - `SymptomsService` is a thin Firestore wrapper over fields the
classifier already produces, and the `startedAt` behavior is model-driven and covered above over HTTP.

## Out of scope

- **Insight / pattern-noticing - the motivating north star, explicitly not built here.** No detecting
  clusters or tendencies, no proactive "you've had frequent headaches lately" nudges, no scheduled
  analysis. That needs history and aggregation (architecture phase 4) and is a later spec. v1 only
  captures the data it will run on.
- **Retrieval and aggregation.** No embeddings, no `/recall`, no "how often do I get headaches"
  counting, no doctor-visit summary. This spec makes symptoms *exist* to count later.
- **Attributing a symptom to a person.** Symptoms are always the user's own here; no `actorIds` on the
  symptom, no classifier work to decide whose symptom it is.
- **A `/symptoms` command or any read surface beyond `/export`.**
- **Editing or deleting a stored symptom** (a `correction` path is a separate concern, unchanged here).
- **Embeddings, `keywords`, or `mentions` on the symptom document** - those belong to retrieval.
- **Any change to the classifier schema, `coerceItem`, `clampSeverity`, or the confidence-forcing
  logic** - the symptom fields and their defences already exist; only prompt text is added.
- **The generic `entries` capture log (phase 0).** Still not built; this adds one more narrow
  projection, the same shape of slice `reminders`, `actors`, and (planned) `notes` are.
