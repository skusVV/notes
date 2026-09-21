---
id: 0006-actor-capture
state: DONE
attempt: 0
max_attempts: 3
branch: feat/0006-actor-capture
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: auth-401
    assert: "POST any update with a wrong X-Telegram-Bot-Api-Secret-Token returns HTTP 401"
  - id: mention-flagged-and-actor-created
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00 (Wednesday, Europe/Kyiv), POST 'Нагадай привітати Антона з днем народження в п'ятницю о 10' from user id U30; a '/export' from U30 shows exactly one reminder with eventAt == '2026-09-18T10:00:00+03:00'; the webhook response for that POST also carries actorQuestion == {mention: 'Антон', questionMessageId: <number>} (mention normalised to nominative case despite the accusative 'Антона' in the text); then POST a second update from U30 in the same chat whose message.reply_to_message.message_id equals that questionMessageId and whose text is 'Антон - мій товариш, разом вчилися в університеті'; a further '/export' from U30 shows actors == [{...}] with exactly one item whose name == 'Антон', whose aliases contains 'Антон', and whose notes contains 'товариш'"
  - id: decline-stops-future-asks
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Нагадай подзвонити Олені в четвер о 18:00' from user id U31; the response carries actorQuestion.mention == 'Олена'; POST a reply to that questionMessageId with text 'ні'; a '/export' from U31 shows actors == []; then POST a second, unrelated reminder 'Нагадай написати Олені в суботу о 12:00' from U31; that response's JSON has no actorQuestion key at all, proving a declined mention is not asked about again"
  - id: known-actor-not-reasked
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Нагадай поздоровити Марію з днем народження в четвер о 15:00' from user id U32; reply to the resulting questionMessageId with 'Марія - моя колега з роботи' so the actor is created; then POST 'Нагадай передати документи Марії в понеділок о 9:00' from U32 (same user, different grammatical case of the same name); that response's JSON has no actorQuestion key, and a '/export' from U32 shows exactly two reminders and exactly one actor (no duplicate created)"
  - id: generic-role-not-flagged
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Нагадай записатися до лікаря в понеділок о 9:00' from user id U33; a '/export' from U33 shows exactly one reminder with eventAt == '2026-09-21T09:00:00+03:00'; that POST's response JSON has no actorQuestion key - a generic professional role is never treated as a candidate actor"
  - id: at-most-one-question-per-message
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST 'Нагадай привітати Антона і подзвонити Олені в суботу о 10:00' from user id U34 (both names unknown to U34); a '/export' from U34 shows exactly one reminder with eventAt == '2026-09-19T10:00:00+03:00'; the response JSON has an actorQuestion key whose value is a single object (mention is either 'Антон' or 'Олена', order not asserted), never an array and never two separate questions"
  - id: stale-reply-not-intercepted
    assert: "With X-Test-Now=2026-09-16T09:00:00+03:00, POST a single update from a fresh user id U35 whose message carries reply_to_message = {message_id: 999999999} (an id that matches no pending question, since U35 has never triggered one) and text 'Нагадай оплатити комуналку в четвер о 11:00'; a '/export' from U35 shows exactly one reminder with eventAt == '2026-09-17T11:00:00+03:00' - an unmatched reply is processed as an ordinary new message, not silently swallowed"
  - id: export-actors-empty-shape
    assert: "A '/export' command update from a user id with no reminders and no actors (U36) returns a reflected reply that parses as JSON exactly equal to {\"reminders\":[],\"actors\":[]}"
failures: []
---

# 0006 - Actors: notice a new person, ask once, remember what you're told

## Context

Today the bot has no idea who a reminder is *about*. "Remind me to call Anton" stores a reminder
with Anton's name buried in `originalText` and nothing else. This spec makes the bot notice a
person it does not yet know, ask about them once, and store whatever the user says - no relation,
no aliases, no structured labeling yet. That refinement is explicitly deferred; this is just
capture, matching the project's own rule that **capture is sacred, interpretation is disposable**
([architecture.md:29-35](../architecture.md#L29-L35)).

The design for this already exists in outline: `knownActors` is already a field on
`ClassifierContext` and is already wired into the prompt
([classifier.service.ts:295-301](../../src/classifier/classifier.service.ts#L295-L301)), the
`mentions[]` output already exists on `ClassificationResult`
([classifier.types.ts:63-72](../../src/classifier/classifier.types.ts#L63-L72)), and the flow -
unmatched mention -> ask -> collect -> resolve future mentions through aliases - is already
described in [architecture.md:538-547](../architecture.md#L538-L547), with the `users/{id}/actors/{id}`
shape at [architecture.md:261-268](../architecture.md#L261-L268) and the `pending`
question-with-expiry shape at [architecture.md:270-276](../architecture.md#L270-L276). What's new
here is wiring those already-planned pieces together for one path.

**Why now, out of the documented order.** [architecture.md:620-622](../architecture.md#L620-L622)
places Actors last (phase 5) specifically so it can retro-label months of history in one pass, using
`mentions[]` captured on the generic `entries` log since phase 1. That generic capture log (phase 0)
does not exist yet - only the `reminders` projection is persisted
([0002-reminders-capture.md](0002-reminders-capture.md), DONE). There is no history to retro-label
either way, so nothing is lost by building a slice of Actors now, scoped to the one thing that is
actually stored: the `reminder` intent.

**Two refinements over the literal architecture.md text, both settled in conversation:**

1. **Only some mentions are worth asking about.** "Нагадай подзвонити лікарю" (call the doctor)
   should never trigger a question - a generic professional/service role is almost always a
   different, unnamed person each time. "Сусідка казала мені" (my neighbor told me) or a proper name
   should - it's plausibly the same specific person every time. This is prompt-level guidance to the
   classifier, backed by an app-level decline list as the safety net for when the model guesses wrong
   in either direction (see Contracts).
2. **Mentions are normalised, not verbatim.** Ukrainian and Russian inflect names by grammatical
   case - "Антона" (accusative) and "Антону" (dative) are both "Антон". Architecture.md's own note
   that `mentions[]` is "raw surface forms as spoken" ([architecture.md:234](../architecture.md#L234))
   does not survive contact with a declining language: matching would never work across two mentions
   of the same person. This spec has the classifier emit the base/dictionary form instead.
   `originalText` on the reminder still keeps the sentence verbatim, so nothing is lost.

`declinedForms[]` also moves off the actor record. Architecture.md lists it as a field on
`users/{id}/actors/{id}` ([architecture.md:268](../architecture.md#L268)), but a declined mention
("лікар" is not a person) has no actor to attach it to. This spec keeps it as
`declinedMentions[]` on the user document instead.

## Scope

The implementer may touch only these:

- `src/classifier/classifier.types.ts` - add `declinedMentions?: string[]` to `ClassifierContext`.
  `mentions` and `knownActors` already exist; no shape change, only the guidance around them.
- `src/classifier/classifier.service.ts` - update the `mentions` schema description and
  `buildInstruction` prompt: normalise to base/dictionary form; only proper names and
  personal/relational references are candidates (never a generic professional/service role); never
  repeat anything already listed under Known people or the new Declined mentions section.
- `src/actors/` (new) - `ActorsService`: known/declined lookups for the classifier context, actor
  creation, decline recording, listing for `/export`, and the one pending-question slot per chat
  (see Contracts). Backed by Firestore, reusing the shared provider from `src/firestore/`.
  Must not throw on construction when `GCP_PROJECT` is unset - same degrade pattern as
  `RemindersService` and `ClassifierService`.
- `src/telegram/telegram.types.ts` - add `reply_to_message?: { message_id: number }` to
  `TelegramMessage`.
- `src/telegram/telegram.service.ts` - the pending-reply check in `handleUpdate` (before command
  routing); mention selection and the reply-threaded question inside `route`'s `reminder` handling;
  `sendMessage` gains an optional `replyToMessageId` param and returns the message id it used;
  `/export` gains an `actors` key.
- `src/telegram/telegram.controller.ts` - thread through a new optional `actorAsks` sink so the
  reflected webhook response can carry `actorQuestion` (test function only, same trust boundary as
  `replies` and `X-Test-Now`).
- `src/telegram/telegram.module.ts`, `src/app.module.ts` - wire `ActorsService`.
- `.env.example`, `README.md` - no new env var; add the Console step for a **Time-to-live** policy on
  collection group `pending`, field `expiresAt`, on both Firestore databases (same pattern 0002 used
  for `reminders.expireAt`).
- `test/` - unit tests for the deterministic pieces (see Acceptance).

Out of bounds without returning to `DRAFT`: `cloudbuild.yaml`, the transcription service, any
reminder scheduling/delivery/recurrence work (0003/0004/0005 - unrelated and not a dependency either
way), inline keyboards, and the `note`/`symptom`/`question`/`correction`/`actor_info` branches.

## Contracts

**`ClassifierContext.declinedMentions?: string[]`** - normalised (lowercase, trimmed) surface forms
the user has said are not a person worth tracking. Passed into the prompt the same way
`knownActors` already is, as a second reason a mention must not be repeated.

**`mentions` guidance (prompt-level, so the model is consistent).**

- A mention is a candidate only if it could plausibly be a specific, recurring person: a proper
  name, or a personal/relational reference (family, friend, neighbour, a named colleague).
- Write each mention in its base dictionary form (nominative case, no grammatical inflection), even
  when the message used a different case - e.g. "Антона" or "Антону" -> "Антон".
- Never include a generic professional or service role with no implied ongoing relationship (doctor,
  taxi driver, cashier, plumber, etc.) - these are usually a different, unnamed person each time.
- Never include anything already listed under Known people or Declined mentions in the prompt.

**`ActorsService`** (`src/actors/actors.service.ts`), Firestore-backed, degrades like
`RemindersService` when unavailable:

- `listKnown(userId): Promise<{ name: string; aliases: string[] }[]>` - reads `users/{userId}/actors`,
  for `ClassifierContext.knownActors`.
- `listDeclined(userId): Promise<string[]>` - reads `users/{userId}.declinedMentions`, for
  `ClassifierContext.declinedMentions`.
- `resolve(userId, mention): Promise<'known' | 'declined' | 'new'>` - case-insensitive match of
  `mention` against known actors' `name`/`aliases` and against `declinedMentions`. This is the
  app-level backstop: correctness of "don't ask again" never depends solely on the model obeying the
  prompt.
- `create(userId, { name, notes }): Promise<void>` - writes `users/{userId}/actors/{autoId}`:
  `{ name, aliases: [name], notes, createdAt }`. `relation` and `birthday` are intentionally absent -
  out of scope, see below.
- `decline(userId, mention): Promise<void>` - normalises `mention` (trim, lowercase) and adds it to
  `users/{userId}.declinedMentions` via an array-union merge.
- `list(userId): Promise<Actor[]>` - for `/export`.
- `getPendingQuestion(userId, chatId): Promise<{ mention: string; questionMessageId: number } | undefined>`
  and `setPendingQuestion(...)` / `clearPendingQuestion(userId, chatId)` - read/write/clear
  `users/{userId}/pending/{chatId}`: `{ kind: 'actor_confirm', mention, questionMessageId, createdAt,
  expiresAt }`. `expiresAt` = `createdAt` + 24h, the field the TTL policy targets. Setting a new
  pending question overwrites any unanswered one for that chat - one slot, last question wins, per
  architecture.md's "at most one question per message" guard
  ([architecture.md:544](../architecture.md#L544)).

**`sendMessage(chatId, text, sink?, replyToMessageId?): Promise<number | undefined>`.** Unchanged
behaviour for existing callers (they ignore the return value). When `replyToMessageId` is given,
every chunk is sent with `reply_to_message_id` in the Telegram API payload. Returns the message id
of the last chunk sent: the real `result.message_id` from Telegram's response on success, or - only
reachable in reflect mode, where a fake chat id makes the real send fail the same way it already does
today - a locally generated placeholder id, so the pending-question flow stays deterministic under
test even though no real Telegram round trip happened.

**Mention detection (inside `route`, only when the message produced a `reminder` item - regardless
of whether that reminder's `eventAt` resolved and stored).** After classifying, scan `result.mentions`
in order and take the first one for which `ActorsService.resolve` returns `'new'`. If one exists:
send a message that is a reply to the *original incoming message* (its `message_id`, not the bot's
own reminder confirmation) asking whether to remember this person; capture the returned message id;
call `setPendingQuestion`; in reflect mode, record `{ mention, questionMessageId }` for the webhook
response. At most one question is ever sent per message, even if several mentions resolve to `'new'`.
A failure sending this question (e.g. Telegram error) is caught and logged, never allowed to affect
the reminder's own reply - matches the degrade-don't-crash pattern used everywhere else in this file.

**Pending-reply handling (in `handleUpdate`, after the `ALLOWED_USERS` gate, before command
routing).** When `message.text` and `message.reply_to_message` are both present: look up
`getPendingQuestion(from.id, message.chat.id)`. If it exists, is unexpired, and
`reply_to_message.message_id === pending.questionMessageId`: handle it here and return -
classification is skipped entirely for this update. Normalise the reply text (trim, lowercase, strip
one trailing `.`/`!`/`?`); if it exactly equals one of `no, nope, ні, нет, не, not a person,
не людина`, call `decline(userId, pending.mention)`; otherwise call `create(userId, { name:
pending.mention, notes: <raw reply text> })`. Either way, `clearPendingQuestion` and send a short
acknowledgement (no `parse_mode`; wording is not asserted). Any other update - no pending question,
an expired one, or a `reply_to_message` that doesn't match - falls through to normal handling
unchanged.

**Webhook response (test function only, `TEST_REFLECT_REPLY=true`).** Response body gains an
optional key: `{ ok: true, replies: string[], actorQuestion?: { mention: string; questionMessageId:
number } }`. Present only on the update whose processing sent an actor-confirm question; absent
otherwise. Production never returns this (reflect is off there, as today).

**`/export` command.** Gains a second top-level key: `{"reminders": [...], "actors": [...]}`, where
each actor is `{ id, name, aliases, notes, createdAt }` (`createdAt` serialised as an ISO string,
same convention as reminders' timestamp fields). Still scoped to the requesting user only, still no
`parse_mode`.

## Invariants (must not break)

- The `ALLOWED_USERS` gate still runs before anything in this spec - before the pending-reply check,
  before commands, before classification.
- The webhook still answers `200` for every handled update and `401` only on a wrong secret token; an
  `ActorsService` failure is caught and logged, never returned as `5xx`.
- Replies set no `parse_mode` - an actor's own notes embed the user's words verbatim.
- Sending the actor-confirm question must never block or fail the reminder's own confirmation reply;
  a failure here is logged, not surfaced to the user as an error.
- Pending state lives in Firestore, never in memory - the instance that asked is not necessarily the
  one that handles the reply. An unanswered question expires quietly (TTL) and blocks nothing else,
  per [architecture.md:563-565](../architecture.md#L563-L565).
- Never log actor names, notes, or mention text - the existing "log ids and counts, not content"
  discipline extends here unchanged (mirrors [0002-reminders-capture.md:167](0002-reminders-capture.md#L167)).
- `ActorsService` must not throw on construction when `GCP_PROJECT` is unset; it degrades the same way
  `RemindersService` and `ClassifierService` already do.

## Acceptance criteria (locked)

Mirrored in the frontmatter `acceptance`. The verifier drives the test function (reply reflection on,
`test` Firestore database) and asserts on stored structure via `/export` and on the `actorQuestion`
field of the webhook response JSON, never on reply wording. Each criterion uses a distinct `from.id`
so stored actors/reminders do not bleed between tests. "Now" is pinned per request with
`X-Test-Now: 2026-09-16T09:00:00+03:00` (a Wednesday in `Europe/Kyiv`), same as 0002/0003.

- **health / auth-401** - carried over, prove the function and auth path on the test deploy.
- **mention-flagged-and-actor-created** - the full round trip: an unknown name in a reminder message
  triggers `actorQuestion` with the normalised (nominative) name; replying to that exact message id
  creates the actor with the reply text as `notes`.
- **decline-stops-future-asks** - replying "ні" records a decline and a later, unrelated message
  naming the same person again produces no `actorQuestion`.
- **known-actor-not-reasked** - once an actor exists, a later mention in a different grammatical case
  resolves via the alias match and is never asked about again.
- **generic-role-not-flagged** - a professional/service role never produces an `actorQuestion`.
- **at-most-one-question-per-message** - two new names in one message still produce exactly one
  question, never two.
- **stale-reply-not-intercepted** - a reply whose target message id matches no pending question is
  treated as an ordinary new message, not swallowed.
- **export-actors-empty-shape** - `/export` with nothing stored returns exactly
  `{"reminders":[],"actors":[]}`.

Unit tests the implementer must add (deterministic, no network): the decline-phrase matcher (exact
list above, case-insensitive, one trailing punctuation mark stripped); `ActorsService.resolve`'s
three-way outcome against a fixture of known actors and declined mentions; the "first `'new'`
mention only" selection over an array with zero, one, and several candidates; the synthetic
message-id fallback path in `sendMessage` (only reachable when the real send fails).

## Out of scope

- **Structured labeling.** `relation`, `birthday`, and any alias beyond `[name]` are not collected in
  this spec - "just gather information" was the explicit ask. A later spec can add the labeling pass
  architecture.md describes.
- **The `actor_info` intent.** Explicit statements like "my wife's birthday is in May" are unchanged -
  still classified but not persisted. This spec's ask-flow is triggered by an unmatched `mention`,
  not by that intent.
- **Any intent besides `reminder`.** `note`, `symptom`, `question`, `correction` do not trigger the
  ask flow here, because none of them persist anything yet to hang a mention off of.
- **The generic `entries`/mentions capture log (phase 0).** This spec does not build it; mention
  detection is scoped to the one thing that is stored today.
- **Backfilling history.** There is none yet for actors - see Context.
- **Inline keyboards.** The whole flow is plain text plus a native Telegram reply; no buttons.
- **Voice replies to a pending question.** Only a text reply is recognised as an answer; a voice
  message arriving as a reply to the question is handled as an ordinary voice message.
- **Reminder scheduling, delivery, or recurrence** (0003/0004/0005) - unrelated, not a dependency
  either direction.
