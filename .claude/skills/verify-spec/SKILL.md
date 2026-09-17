---
name: verify-spec
description: >
  Hand an IMPLEMENTED spec to the spec-verifier agent to test end to end on the isolated test Cloud
  Function and run the security pass. Trigger when the user runs /verify-spec <spec-id>, or asks to
  "verify / test the spec". Do NOT use it to write or fix code - the verifier reports failures, it does
  not patch them. Do NOT run it on a spec that is not yet IMPLEMENTED.
argument-hint: '<spec-id>'
---

# Verify a spec

Thin entry point. The procedure lives in [docs/specs/README.md](../../../docs/specs/README.md) and the
[spec-verifier](../../agents/spec-verifier/AGENT.md) agent.

This is the **verify-only** stage, for when a spec is already `IMPLEMENTED` and you want just the test
pass. The full autonomous chain - build, verify, refresh the architecture map, merge to `main`, push,
and mark `DONE` with no human in the loop - is [/implement-spec](../implement-spec/SKILL.md).

## Steps

1. Resolve the spec id from the argument to `docs/specs/<id>.md`. If it is missing or its `state` is
   not `IMPLEMENTED`, stop and tell the user why.
2. Confirm `TEST_URL` and `TEST_WEBHOOK_SECRET` are available - they live in the git-ignored
   [.env](../../../.env), not in the shell environment, so source it (e.g. `set -a; source .env; set
   +a`) rather than asking the user to export them. Only stop and ask the user if `.env` itself is
   missing those keys.
3. Spawn the **spec-verifier** agent (via the Agent tool) with the spec id. Let it own the loop:
   take the `.testing-lock`, deploy the feature branch to the test function via `testing`, assert
   every acceptance criterion over HTTP, run the security checklist, set `VERIFIED` or
   `NEEDS-REWORK`, and reset `testing` back to `main`.
4. Relay the agent's verdict: the per-criterion evidence, the security verdict, and confirmation that
   the lane was freed and `testing` reset to `main`. On `VERIFIED`, tell the user this stage stops at
   `VERIFIED`: merging `feat/<id>` to `main` is a manual step here (or run
   [/implement-spec](../implement-spec/SKILL.md), which does the whole chain and merges for you).
