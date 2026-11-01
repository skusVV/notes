# Bug-fix pipeline

This folder is the bug twin of [../specs/](../specs/README.md). A bug is written down like a spec,
marked `READY`, and run through the **same pipeline** with `/fix-bug <id>`: the **spec-implementer**
agent fixes it on `fix/<id>`, the **spec-verifier** agent proves it on the isolated test Cloud
Function, and on `VERIFIED` the orchestrator regenerates the architecture map, merges to `main`,
pushes (the production deploy) and marks the bug `DONE`.

## TL;DR

- **One bug = one file** here, named `NNNN-<slug>.md` (its own counter, separate from specs), copied
  from [TEMPLATE.md](TEMPLATE.md). Reference it as `BUG-NNNN`.
- **Lifecycle** is the spec lifecycle, with `OPEN` in place of `DRAFT`:
  `OPEN -> READY -> IN-PROGRESS -> IMPLEMENTED -> IN-TESTING -> VERIFIED -> DONE`, plus the
  `NEEDS-REWORK` loop and the `BLOCKED` exit. Same rules, same agents, same `.testing-lock`.
- **Branch is `fix/<id>`**, not `feat/<id>`. Commits are not made to `main` by the agents.
- **Reproduction comes first.** A bug without a way to see it fail cannot reach `READY`.
- **Regression test is mandatory.** The implementer first writes a unit test that fails on the
  current code, then fixes the code until it passes. The test stays in the repo.

## What a good bug file has

| Part | Meaning |
|---|---|
| **Symptom** | What a person sees go wrong, in plain words. |
| **Reproduction** | Exact steps or HTTP calls that show it. Must fail today. |
| **Root cause** | What is actually broken and where (file and line). Facts only, no guessing. Write `UNKNOWN` and what to investigate if not yet known. |
| **Fix scope** | The files the fix may touch. Anything else is out of bounds. |
| **Acceptance** | Machine assertions, same rules as specs: exact output for deterministic surfaces, stored structure for model-driven ones. Always includes **repro-fixed** (the reproduction now passes) and at least one **no-regression** check on the neighbouring behaviour. |
| **Out of scope** | What this fix deliberately leaves alone. |

## How the pipeline differs from `/implement-spec`

1. The agents read `docs/bugs/<id>.md`, not `docs/specs/<id>.md`. The orchestrator says so in the
   prompt, and the agents treat "spec" as "bug file".
2. The implementer's first commit is the **failing regression test**; the fix commit follows.
3. The verifier runs the **repro** against the test function first and expects it to behave
   correctly after the deploy. It does not need a "new behavior" poll string: it polls the
   reproduction until it flips to the fixed result.
4. A fix must not widen behavior. If the fix needs a design decision, stop and write a spec instead.

## Severity (for ordering, not for the pipeline)

`high` loses or corrupts data, or sends something wrong to a person; `medium` breaks a feature but
loses nothing; `low` is cosmetic or only affects tests and tooling.

## Index

| Bug | State | Severity | Summary |
|---|---|---|---|
| [0001-classifier-reminder-tests-stale](0001-classifier-reminder-tests-stale.md) | OPEN | low | Two classifier reminder tests fail because their fixtures lack the new `evidence` field. |
| [0002-ingest-actor-question-undeliverable](0002-ingest-actor-question-undeliverable.md) | OPEN | medium | A "who is this?" question raised by text sent through `/ingest/message` cannot reach the owner. |
