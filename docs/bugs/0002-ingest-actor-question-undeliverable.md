---
id: 0002-ingest-actor-question-undeliverable
state: READY
severity: medium
attempt: 0
max_attempts: 3
branch: fix/0002-ingest-actor-question-undeliverable
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: repro-fixed
    assert: "POST /ingest/message (valid X-Ingest-Secret) with body {\"userId\":900000004,\"text\":\"Remind me tomorrow at 10:00 to call Zinovia\"} and X-Test-Now=2026-12-01T09:00:00+02:00 returns HTTP 200 with ok == true, a replies array confirming the reminder, and an actorQuestion object whose mention is 'Zinovia' and whose questionMessageId is a number"
  - id: answer-works
    assert: "Continuing from repro-fixed: POST a webhook update (valid secret) from user 900000004 in chat 900000004 with text 'my aunt from Lviv' and reply_to_message.message_id equal to that questionMessageId; a '/export' from 900000004 then shows an actor named 'Zinovia' whose notes equal 'my aunt from Lviv'"
  - id: webhook-unchanged
    assert: "POST a webhook update from user 900000005 with text 'Remind me tomorrow at 10:00 to call Yaroslava' and X-Test-Now=2026-12-01T09:00:00+02:00; the response has an actorQuestion with mention 'Yaroslava', exactly as before the fix"
  - id: reply-to-only-for-real-messages
    assert: "npm test passes and includes a regression test, failing on the pre-fix code, asserting that the actor question for an ingested message is sent with no reply_to_message_id, while for a webhook message it is still sent with reply_to_message_id equal to the user's message_id"
  - id: no-regression-ingest
    assert: "POST /ingest/message with {\"userId\":900000004,\"text\":\"/version\"} returns 200 with a reply starting 'notes-bot '; with {\"userId\":900000004,\"text\":\"   \"} it returns 400"
failures: []
---

# BUG-0002 - "Who is this?" question from `/ingest/message` cannot reach the owner

> **OPEN.** Found 2026-11-01 by the spec-implementer for 0013 and confirmed in the verifier's notes.
> **READY 2026-11-16** (owner). Root cause confirmed by reading the code (see below). Unique names
> (Zinovia, Yaroslava) avoid colliding with actors already stored for the test users.

## Symptom

When a note or reminder dictated through the iPhone Shortcut names a new person ("remind me to call
Olga at 5"), the bot is meant to ask once who that person is ([0006](../specs/0006-actor-capture.md)).
Sent through `/ingest/message`, that question most likely never arrives on the phone owner's Telegram.
The reminder itself is still saved and confirmed, so the failure is quiet.

## Reproduction

1. On the test function, `POST /ingest/message` (valid `X-Ingest-Secret`) with
   `{"text":"Remind me tomorrow at 10:00 to call Olga"}`.
2. Compare with the same text sent as a normal webhook update from the same user.
3. Expected today: through the webhook an actor question is asked; through `/ingest` the question is
   not delivered (look for a logged send error naming the question's `reply_to_message_id`).

## Root cause

**Confirmed by reading the code (2026-11-16); still to be seen live on the test function.**
`handleIngestedText` ([telegram.service.ts](../../src/telegram/telegram.service.ts), around line 429)
builds a synthetic update whose `message_id` is the current epoch-milliseconds stamp, a message
Telegram has never seen. `askAboutNewMention` (around line 1092) sends the question with
`reply_to_message_id` set to that id. In production `sendMessage` has no `sink`, so Telegram's
"message to be replied not found" error is thrown, caught by `askAboutNewMention`, logged, and
dropped: no question is sent and no pending question is stored. On the test function the reflect
`sink` hides it, because a failed send there returns a synthetic id and carries on. That is why the
0013 verification did not catch it.
Second half: `handleIngestedText` calls `handleUpdate` without `actorAsks`, and the ingest controller
has no `actorQuestion` in its response, so even in reflect mode a test cannot see or answer the
question.

Answering is unaffected once the question is delivered. The pending match compares against the
*bot's question* message id (`pending.questionMessageId`), not the user's original message.

## Fix scope

- `src/telegram/telegram.service.ts` - when the update is a synthetic ingest update, send the actor
  question as a plain message (no `reply_to_message_id`), and still record the pending question keyed
  the way the answer lookup expects.
- `src/ingest/ingest.controller.ts` - pass `actorAsks` through in reflect mode, as the webhook does.
- `test/` - a regression test for the ingest case.

Out of bounds: the actor-capture flow for ordinary chat messages, the classifier, the `/ingest`
contract (paths, status codes, secret handling).

## Invariants (must not break)

- The webhook behavior for normal chat messages is byte-for-byte unchanged.
- Ingested text is never logged; only the user id.
- Replies set no `parse_mode`, and go through `sendMessage` with its chunking.
- A failure to deliver the question never fails the request: still `200`.

## Acceptance criteria (locked at READY)

- **repro-fixed:** on the test function, the reproduction above returns `200`, and the reflected
  response contains an `actorQuestion` for Olga.
- **answer-works:** answering that question from the same user stores the actor, exactly as for a chat
  message (`/export` shows it).
- **webhook-unchanged:** the same text sent as a normal webhook update behaves as before (one question,
  asked as a reply).
- **no-regression-ingest:** `/ingest/message` with `{"text":"/version"}` still returns
  `notes-bot <semver>` and `{"text":"   "}` still returns `400`.

## Out of scope

Deciding whether an ingest-originated question should be asked at all; letting the Shortcut show the
question on the phone.
