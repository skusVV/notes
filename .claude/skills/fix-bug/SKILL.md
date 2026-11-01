---
name: fix-bug
description: >
  Run a READY bug file from docs/bugs/ all the way to production, unattended. The spec-implementer
  writes a failing regression test and fixes the bug on fix/<id>, the spec-verifier proves it on the
  isolated test function, and on VERIFIED this skill regenerates architecture.html, merges fix/<id>
  to main, and pushes - which triggers the prod deploy - then marks the bug DONE. Trigger when the
  user runs /fix-bug <bug-id>, or asks to "fix bug N" / "ship the bugfix". Do NOT run it on a bug
  that is not READY. For a new feature use /implement-spec instead.
argument-hint: '<bug-id>'
---

# Fix a bug, end to end

`/fix-bug <id>` is [/implement-spec](../implement-spec/SKILL.md) for bugs: **fix -> verify -> (on
pass) regenerate the architecture map -> merge to `main` -> push (prod deploy) -> mark `DONE`.** The
lifecycle and file format live in [docs/bugs/README.md](../../../docs/bugs/README.md). The workers
are the same two agents: [spec-implementer](../../agents/spec-implementer/AGENT.md) and
[spec-verifier](../../agents/spec-verifier/AGENT.md).

Everything in `/implement-spec` applies unchanged - the autonomous-authorization scope, the rule that
only this orchestrator writes `main`, no local `gcloud`, no deploy by hand - **except** the
differences below. Read that skill for the shared rules instead of duplicating them here.

## Differences from /implement-spec

1. **File and branch.** The file is `docs/bugs/<id>.md`; the branch is `fix/<id>`, not `feat/<id>`.
   The agents are written for `docs/specs/` and `feat/`, so **every prompt to them must say**: "the
   work item is the bug file `docs/bugs/<id>.md`; read 'spec' as 'bug file' and `feat/<id>` as
   `fix/<id>`; the branch is `fix/<id>`."
2. **Regression test first.** Tell the implementer to commit a unit test that **fails on the current
   code** before touching `src/`, then fix the code until it passes. It must report that it saw the
   test fail first. A fix with no failing-first test is sent back.
3. **No new-behavior poll.** Tell the verifier to confirm the deploy is live by polling the bug's
   reproduction until it flips from the broken result to the fixed one, instead of waiting for a
   new command to appear.
4. **Scope is a fence.** The implementer may touch only the files named in the bug's "Fix scope". If
   the fix needs anything else, or a design decision, it returns `BLOCKED` and the bug becomes a spec.
5. **Commit messages.** `Fix BUG-<n>: <summary>` for the fix, `Mark bug <id> DONE` for completion,
   and `Refresh architecture map for bug <id>` only if the map actually changed.

## Steps

### 0. Gate
1. Resolve `<id>` to `docs/bugs/<id>.md`. If missing, or `state` is not `READY`, stop and say why
   (an `OPEN` bug has no locked reproduction or acceptance yet).
2. Confirm `TEST_URL` and `TEST_WEBHOOK_SECRET` (plus `TEST_INGEST_SECRET` if the bug touches
   `/ingest/*`) are in the git-ignored [.env](../../../.env); source it, do not ask the user.
3. Confirm the working tree is clean (`git status --short` empty). If not, stop: the implementer's
   checkout would destroy unrelated edits.

### 1. Fix + verify loop (auto-rework up to `max_attempts`)
Same loop as `/implement-spec` step 1: spawn the **spec-implementer** (it sets `IMPLEMENTED`), then
the **spec-verifier** (it sets `VERIFIED` or `NEEDS-REWORK`). Loop on `NEEDS-REWORK` while
`attempt <= max_attempts`; stop and relay on `BLOCKED`. Include the difference notes above in each
prompt.

### 2. Ship (only after VERIFIED), done by you, not delegated
1. On `fix/<id>`, run the **update-architecture-docs** skill. Commit `architecture.html` only if it
   changed.
2. `git checkout main && git merge --ff-only fix/<id>` (fall back to `--no-ff` if main moved).
3. Set `state: DONE` in `docs/bugs/<id>.md`, update that bug's row in the index in
   [docs/bugs/README.md](../../../docs/bugs/README.md), and commit `Mark bug <id> DONE`.
4. `git push origin main` once. That push is the production deploy.

### 3. Report
Final state and attempts; the repro result before and after; the per-criterion evidence and security
verdict; what changed in the architecture map; and that `main` was pushed and the deploy is building.
If the run stopped early, say which stage and why, and that `fix/<id>` is left intact.

## What this skill never does
- Run `gcloud`, or deploy by hand.
- Ship a bug that is not `VERIFIED`.
- Let a worker agent touch `main`.
- Widen the fix beyond the bug file's scope.
