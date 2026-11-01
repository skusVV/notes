---
id: NNNN-slug
state: OPEN
severity: medium
attempt: 0
max_attempts: 3
branch: fix/NNNN-slug
acceptance: []
failures: []
---

# BUG-NNNN - <short title>

> Copy this file to `NNNN-<slug>.md` (next free number), fill every section, then move `state` to
> `READY` once the reproduction is exact and the acceptance criteria are locked. See
> [README.md](README.md) for the lifecycle.

## Symptom

What goes wrong, as a person would describe it.

## Reproduction

Exact steps or HTTP calls. It must fail on the current code.

## Root cause

What is broken and where, with file links. `UNKNOWN` plus what to investigate, if not yet known.

## Fix scope

The only files the fix may touch.

- `src/...`
- `test/...` (the regression test)

## Invariants (must not break)

The load-bearing rules from [../../CLAUDE.md](../../CLAUDE.md) that sit next to this fix.

## Acceptance criteria (locked at READY)

- **repro-fixed:** <the reproduction now gives the correct result>
- **no-regression:** <a neighbouring behavior still works>

## Out of scope

What this fix deliberately does not touch.
