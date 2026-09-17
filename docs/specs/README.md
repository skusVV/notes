# Spec-driven delivery pipeline

This folder is the control surface for how work gets built here. You and Claude write a **spec** and
mark it `READY`; from there the **`/implement-spec` orchestrator** takes it to production unattended -
a **spec-implementer** agent builds it, a separate **spec-verifier** agent tests it against a live,
isolated test Cloud Function and runs a security pass, and on a pass the orchestrator refreshes the
architecture map, merges to `main`, and pushes (which deploys). The two worker agents never touch
`main`; the orchestrator, acting as your delegate, is the one thing that does. The spec's frontmatter
is the single source of truth for where each piece of work is.

## TL;DR

- **Use when:** a change is big enough to be worth writing down and handing to an agent. Small
  throwaway edits do not need a spec.
- **One spec = one file** here, named `NNNN-<slug>.md`, copied from [TEMPLATE.md](TEMPLATE.md).
- **Lifecycle:** `DRAFT -> READY -> IN-PROGRESS -> IMPLEMENTED -> IN-TESTING -> VERIFIED -> DONE`,
  with a `NEEDS-REWORK` loop and a `BLOCKED` exit.
- **`/implement-spec` ships it, hands-off:** once a spec is `READY`, that one command builds, verifies,
  refreshes the architecture map, merges `feat/<id>` to `main`, and pushes to production - no human in
  the loop. Marking `READY` is your last manual step.
- **Two agents, on purpose:** the implementer builds, a *different* agent verifies. An agent grading
  its own work is biased to "it works"; fresh eyes are the check.
- **Acceptance criteria are assertions, not prose** - see below. This is what makes autonomy
  *verified* rather than assumed.

## The state machine

```
 DRAFT -> READY -> IN-PROGRESS -> IMPLEMENTED -> IN-TESTING -+-> VERIFIED ->(orchestrator merges+pushes)-> DONE
   ^                   ^                             |         |
   |             (retry, attempt++)                 |         +-> NEEDS-REWORK -+
   |                   +-----------------------------------------------------+  |
   |                                                                            |
   +----------------------------------------- BLOCKED (needs you) <- attempt > cap
```

| State | Who sets it | Entry condition |
|---|---|---|
| `DRAFT` | you + Claude | being written; acceptance criteria not yet locked |
| `READY` | you | **acceptance criteria locked** and scope/files named; an implementer may claim it |
| `IN-PROGRESS` | spec-implementer | claimed; building on `feat/<id>` |
| `IMPLEMENTED` | spec-implementer | build + lint + unit tests all green on the feature branch |
| `IN-TESTING` | spec-verifier | test lane free; `testing` reset to the feature branch and pushed; test function deployed |
| `NEEDS-REWORK` | spec-verifier | a criterion or the security pass failed; reason appended to `failures`; `testing` reset to `main`; `attempt` incremented |
| `VERIFIED` | spec-verifier | every criterion passed and the security pass is clean; `testing` reset to `main` |
| `DONE` | orchestrator (`/implement-spec`) | orchestrator merged `feat/<id>` to `main` and pushed once; the production deploy is building (it does not block on the deploy finishing) |
| `BLOCKED` | either agent | `attempt > max_attempts`, or an ambiguity the agents cannot resolve |

## Spec frontmatter (the machine state)

```yaml
---
id: 0001-version                 # matches the filename, no extension
state: READY                     # one of the states above
attempt: 0                       # rework counter; starts at 0
max_attempts: 3                  # BLOCKED once attempt exceeds this
branch: feat/0001-version        # the implementer's feature branch
acceptance:                      # locked at READY; the verifier checks exactly these
  - id: health
    assert: "GET / returns 200 with body {\"status\":\"ok\"}"
  - id: version-format
    assert: "POST a /version update returns a reflected reply matching /^notes-bot \\d+\\.\\d+\\.\\d+$/"
failures: []                     # verifier appends {attempt, stage, detail} on each NEEDS-REWORK
---
```

## Writing acceptance criteria (NORMATIVE)

An agent can only build unattended if it can check itself. So every criterion must be a **machine
assertion the verifier can run over HTTP**, in one of two flavors:

- **Deterministic surfaces - assert exact output.** Health check, the 401/200 auth contract, command
  replies, the allowlist refusal, voice guard replies. These do not touch the model, so their output
  is fixed and can be matched exactly.
- **Model-driven behavior - assert on stored structure, never on wording.** For anything that goes
  through the classifier, assert on what ends up stored (read back via `/export` once persistence
  exists), e.g. *"a `symptom` document with `type: headache` and `severity: null` exists"* - not on
  the exact sentence the bot replied. The model's phrasing is not a contract; the stored record is.

> A spec whose criteria are prose ("it should feel right") cannot reach `READY`. Prose criteria put
> an LLM back in the position of vibe-checking its own output, which is the exact failure this
> pipeline exists to remove.

## The testing lane (`.testing-lock`)

There is **one** test function, so **one** spec may be `IN-TESTING` at a time. The verifier records
the occupant in `.testing-lock` (the spec id) on entering `IN-TESTING`, and clears it on leaving
(`VERIFIED` or `NEEDS-REWORK`). A verifier finding the lock held by another spec waits rather than
colliding.

## The disposable `testing` branch (NORMATIVE)

`testing` is throwaway scaffolding, kept equal to `main` when idle. The **feature branch is the real
work.** The verifier drives it like this:

```bash
# enter the lane: point the test function at the feature branch
git checkout testing && git reset --hard feat/<id> && git push --force origin testing
# ... deploy runs, verification runs ...
# leave the lane (pass or fail): return the test function to production code
git checkout testing && git reset --hard main && git push --force origin testing
```

The **worker agents** never write `main`. Merging a `VERIFIED` feature branch to `main` and pushing
it - the only path to production - is done by the **`/implement-spec` orchestrator** (the top-level
session, your delegate), not by either agent.

## Git permissions (NORMATIVE)

Two grants, and only these, are the pipeline's automated git actions:

- **The worker agents:** commit to `feat/<id>` and force-push `testing`. They do **not** commit,
  merge, or push to `main`, ever.
- **The `/implement-spec` orchestrator** (the top-level session, your delegate): once a spec is
  `VERIFIED`, commit the refreshed `architecture.html` to `feat/<id>`, merge `feat/<id>` to `main`,
  commit the `DONE` state on `main`, and `git push origin main` **once** (which triggers the
  production deploy). It runs no `gcloud` - the push is the only deploy mechanism.

Both are deliberately narrow, production-safe exceptions to the global "no automatic commits" rule,
and they apply only inside this pipeline. The orchestrator's grant is armed by the explicit act of
invoking `/implement-spec`: each run re-authorizes it, and nothing outside that run inherits it. If
the grant is not in effect, the tooling stops at the commit boundary and reports instead.

## The test environment

- **Isolated function:** `telegram-echo-bot-test`, deployed by the `testing` trigger from the same
  [cloudbuild.yaml](../../cloudbuild.yaml), with its own bot token (`TELEGRAM_BOT_TOKEN_TEST`), its
  own webhook secret (`TELEGRAM_WEBHOOK_SECRET_TEST`), reply reflection on, and the `test` Firestore
  database. Nothing it does touches production data.
- **Reply reflection:** with `TEST_REFLECT_REPLY=true`, the webhook response body carries the replies
  the bot composed (`{ok:true, replies:[...]}`), so the verifier reads them over plain HTTP with no
  GCP identity. Off in production.
- **How the verifier drives it:** it POSTs crafted `TelegramUpdate` payloads to the test function URL
  with the `X-Telegram-Bot-Api-Secret-Token` header (value from the local env var
  `TEST_WEBHOOK_SECRET`), and asserts on the reflected replies and, later, on `/export` output.

## Roles: who moves each state

- **You + Claude:** author the spec (`DRAFT`), lock the criteria and mark `READY`. That `READY` mark
  is the last manual step.
- **`/implement-spec` orchestrator:** from `READY`, drives the whole chain - loops the implementer and
  verifier (auto-rework up to `max_attempts`), and on `VERIFIED` refreshes `architecture.html`, merges
  `feat/<id>` to `main`, pushes, and sets `DONE`.
- **spec-implementer:** `READY -> IN-PROGRESS -> IMPLEMENTED` (and `NEEDS-REWORK -> IN-PROGRESS ->
  IMPLEMENTED` on a rework loop).
- **spec-verifier:** `IMPLEMENTED -> IN-TESTING -> VERIFIED | NEEDS-REWORK` (`BLOCKED` past the cap).
