---
name: implement-spec
description: >
  Hand a READY spec to the spec-implementer agent to build on its own feature branch. Trigger when the
  user runs /implement-spec <spec-id>, or asks to "implement spec N" / "build the spec". Do NOT use it
  to verify or deploy - that is /verify-spec. Do NOT run it on a spec that is not yet READY.
argument-hint: '<spec-id>'
---

# Implement a spec

Thin entry point. The procedure lives in [docs/specs/README.md](../../../docs/specs/README.md) and the
[spec-implementer](../../agents/spec-implementer/AGENT.md) agent.

## Steps

1. Resolve the spec id from the argument to `docs/specs/<id>.md`. If it is missing or its `state` is
   not `READY`, stop and tell the user why (only a `READY` spec can be implemented).
2. Spawn the **spec-implementer** agent (via the Agent tool) with the spec id. Let it own the build:
   branch, implement to scope, unit-test, run build + lint + tests, and move the state to
   `IMPLEMENTED`.
3. Relay the agent's report: the final state, the branch, validation results, and anything that
   blocked it. Do not summarize away a failure.

Note the git-permission rule from the README: the agent commits only to `feat/<id>`, never to `main`.
If the pipeline commit grant is not in effect, it stops at the commit boundary and reports instead.
