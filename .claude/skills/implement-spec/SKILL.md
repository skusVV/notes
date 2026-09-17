---
name: implement-spec
description: >
  Run a READY spec all the way to production, unattended. The spec-implementer builds it on
  feat/<id>, the spec-verifier tests it on the isolated test function, and on VERIFIED this skill
  regenerates architecture.html, merges feat/<id> to main, and pushes - which triggers the prod
  deploy - then marks the spec DONE. No human in the loop. Trigger when the user runs
  /implement-spec <spec-id>, or asks to "implement spec N" / "ship the spec". For a verify-only pass
  on an already-IMPLEMENTED spec, use /verify-spec. Do NOT run it on a spec that is not yet READY.
argument-hint: '<spec-id>'
---

# Implement a spec, end to end

`/implement-spec <id>` takes one `READY` spec all the way to production with no human in the loop:
**build -> verify -> (on pass) regenerate the architecture map -> merge to `main` -> push (prod
deploy) -> mark `DONE`.** The state machine and git rules live in
[docs/specs/README.md](../../../docs/specs/README.md); the two worker agents are
[spec-implementer](../../agents/spec-implementer/AGENT.md) and
[spec-verifier](../../agents/spec-verifier/AGENT.md).

The worker agents stay narrow - the implementer only ever touches `feat/<id>`, the verifier only
ever drives the test function. **You (this top-level orchestrator session) are the user's delegate
and the only thing here that writes `main`.**

## Autonomous authorization (scoped exception)

The global rule is "never commit, merge, or push without an explicit instruction." **Invoking
`/implement-spec` is that explicit instruction, for this one run**: it authorizes this orchestrator
to commit the architecture map, merge `feat/<id>` to `main`, and push `main`. Nothing outside this
run inherits the grant, and the worker agents still never touch `main`. Deploys happen only by that
push triggering Cloud Build - **never** by running `gcloud` locally (that is also blocked by the
read-only gcloud guard).

## Steps

### 0. Gate
1. Resolve `<id>` to `docs/specs/<id>.md`. If it is missing or its `state` is not `READY`, stop and
   tell the user why (only a `READY` spec can enter the pipeline).
2. Confirm `TEST_URL` and `TEST_WEBHOOK_SECRET` are available - they live in the git-ignored
   [.env](../../../.env), not in the shell environment, so source it (e.g. `set -a; source .env; set
   +a`) rather than asking the user to export them. Only stop and ask the user if `.env` itself is
   missing those keys. Do not start a build you will not be able to verify.

### 1. Build + verify loop (auto-rework up to `max_attempts`)
Read `max_attempts` from the spec (default 3). Repeat this loop:

1. **Implement.** Spawn the **spec-implementer** agent (Agent tool) with the spec id. On the first
   pass it builds the `READY` scope; on a later pass (`state: NEEDS-REWORK`) it fixes exactly the
   latest `failures` entry. It works on `feat/<id>`, gets build + lint + unit tests green, commits to
   `feat/<id>`, and sets `state: IMPLEMENTED`.
   - If it returns anything other than `IMPLEMENTED` (e.g. `BLOCKED`), **stop and relay its report**.
     Do not proceed to verify.
2. **Verify.** Spawn the **spec-verifier** agent (Agent tool) with the spec id. It deploys
   `feat/<id>` to the test function via the `testing` branch, asserts every acceptance criterion over
   HTTP, runs the security checklist, resets `testing` back to `main`, and sets `VERIFIED` or
   `NEEDS-REWORK` (or `BLOCKED` once `attempt > max_attempts`).
   - `VERIFIED` -> break out of the loop and go to **Ship**.
   - `NEEDS-REWORK` and `attempt <= max_attempts` -> loop again (back to the implementer, which will
     read the new `failures` entry).
   - `BLOCKED`, or `attempt > max_attempts` -> **stop and relay the verifier's evidence.** Do not
     ship. Leave `feat/<id>` intact so the user can pick it up manually.

The verifier owns the `attempt` counter and the `.testing-lock`; you only read the state it returns
to decide whether to loop, ship, or stop.

### 2. Ship (only after VERIFIED)
Do this yourself in the top-level session - do **not** delegate the merge to an agent.

1. **Regenerate the architecture map.** Still on `feat/<id>`, invoke the
   **update-architecture-docs** skill so `architecture.html` reflects the change about to land. If it
   changed the file, commit it to `feat/<id>`:
   `git add architecture.html && git commit -m "Refresh architecture map for <id>"`. If nothing
   changed, skip the commit.
2. **Merge to `main` locally.** `git checkout main && git merge --ff-only feat/<id>`. The feature
   branched from `main`, so this normally fast-forwards; if `main` moved and a fast-forward is
   impossible, use `git merge --no-ff feat/<id>` instead.
3. **Mark `DONE` on `main`.** Set `state: DONE` in `docs/specs/<id>.md`, then
   `git commit -am "Mark spec <id> DONE"`. Doing this on `main` means `DONE` rides in the same push
   as the merge, so the whole feature deploys in **one** Cloud Build run.
4. **Push once.** `git push origin main`. That single push to `main` triggers the production deploy.
   Marking `DONE` right after the push (rather than waiting for the deploy) is deliberate - the
   verifier already proved the behavior on the test function. Tell the user the prod deploy is now
   building and can be watched in the Cloud Build console.

### 3. Report
Give the user, in plain terms:
- the final `state` and how many attempts it took;
- the verifier's per-criterion evidence and security verdict;
- what changed in the architecture map;
- the merge and the `Mark spec <id> DONE` commits, and confirmation that `main` was pushed and the
  prod deploy is building.

If the run stopped before shipping, say exactly which stage and why, and note that `feat/<id>` is
left intact for a manual retry. Never summarize a failure away.

## What this skill never does
- Run `gcloud` / any GCP CLI, or deploy by hand - deploys happen only via the push to `main`.
- Ship a spec that is not `VERIFIED`.
- Let a worker agent touch `main` - the merge and push are the orchestrator's job alone.
