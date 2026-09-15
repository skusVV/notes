---
id: NNNN-slug
state: DRAFT
attempt: 0
max_attempts: 3
branch: feat/NNNN-slug
acceptance: []
failures: []
---

# NNNN - <short title>

> Copy this file to `NNNN-<slug>.md` (next free number), fill every section, then move `state` to
> `READY` once the acceptance criteria are locked. See [README.md](README.md) for the lifecycle.

## Context

Why this change exists - the problem or need, and the intended outcome. Two or three sentences. Link
to [../architecture.md](../architecture.md) sections where relevant.

## Scope

The exact files and modules the implementer may touch. Be specific; anything not listed is
out of bounds without coming back to `DRAFT`.

- `src/...`

## Contracts

The signatures, types, env vars, endpoints, or reply strings this change introduces or changes.
Enough that the implementer and verifier agree on the shape without guessing.

## Invariants (must not break)

The load-bearing rules from [../../CLAUDE.md](../../CLAUDE.md) this change must preserve. Pull the
ones that actually apply, e.g.:

- The webhook always answers `200` except a wrong secret token (`401`); handling failures are logged,
  never returned as `5xx`.
- The `ALLOWED_USERS` gate runs before any voice download or model call.
- Replies set no `parse_mode`.
- Health-data discipline: never log transcripts, extraction, or query results.

## Acceptance criteria (locked at READY)

Machine assertions the verifier runs over HTTP. Deterministic surfaces assert exact output;
model-driven behavior asserts on stored structure via `/export`, never on wording. Mirror these into
the frontmatter `acceptance` list.

- **<id>:** <assertion>

## Out of scope

What this spec deliberately does not do, so the implementer does not gold-plate and the verifier does
not fail it for a missing thing that was never promised.
