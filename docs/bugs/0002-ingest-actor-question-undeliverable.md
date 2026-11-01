---
id: 0002-ingest-actor-question-undeliverable
state: OPEN
severity: medium
attempt: 0
max_attempts: 3
branch: fix/0002-ingest-actor-question-undeliverable
acceptance: []
failures: []
---

# BUG-0002 - "Who is this?" question from `/ingest/message` cannot reach the owner

> **OPEN.** Found 2026-11-01 by the spec-implementer for 0013 and confirmed in the verifier's notes.
> **Root cause is a hypothesis until the implementer reproduces it.** Do not move to `READY` before
> the reproduction below is confirmed against the test function.

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

Hypothesis: the actor question is sent as a **reply** to the user's message, using that message's
`message_id`. A message from `/ingest` has a made-up `message_id` that Telegram does not know, so the
reply-to send fails, the existing code catches and logs it, and nothing is delivered. The ingest path
also does not pass `actorAsks`, so the question is not even reflected in the test response. See
`handleIngestedText` in [telegram.service.ts](../../src/telegram/telegram.service.ts) and the actor
question send. To be confirmed.

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
