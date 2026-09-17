---
name: update-architecture-docs
description: >
  Regenerate architecture.html, the clickable architecture map at the repo root, from the current
  state of the codebase. Trigger when the user runs /update-architecture-docs, or asks to "update the
  architecture diagram / page", "refresh the architecture docs", or says the architecture map is
  stale. Do NOT use it to edit docs/architecture.md itself (that file is the planning doc, hand-
  written by the user) - this skill only regenerates the derived HTML visualization.
---

# Update the architecture map

`architecture.html` at the repo root is a visual, clickable map of this system: what talks to what,
the request flow, the classifier's intents, every source file, config and secrets, the deploy
pipeline, the spec-driven delivery workflow, and the planned-but-not-built memory layer. It is
generated, not hand-maintained prose - treat it the way you'd treat a diagram exported from code:
correct **because** it was re-derived from the current source, not because someone remembered to
update it.

## Before touching the file: re-read the sources, don't trust memory

Re-read these fresh every time this skill runs, even if you (or a prior turn) summarized them
recently - the whole point is that the page reflects what is actually in the repo *right now*:

- `src/**/*.ts` - every service, controller, module, and types file. This is where intents, routing
  order, env var reads, and defensive parsing rules live.
- [cloudbuild.yaml](../../../cloudbuild.yaml) - deploy steps, `--set-secrets`, `--set-env-vars`, substitutions (prod vs `testing`).
- [package.json](../../../package.json) - version number and dependencies.
- [README.md](../../../README.md) - env var table, Console setup steps, behaviour notes.
- [docs/architecture.md](../../../docs/architecture.md) - the planned memory-layer design (schema, retrieval, build order, cost). Everything sourced from here stays marked `PLANNED` in the page.
- [docs/specs/README.md](../../../docs/specs/README.md) and `docs/specs/*.md` - the spec state machine and current spec states.
- `.claude/agents/**/AGENT.md`, `.claude/skills/**/SKILL.md`, `.claude/hooks/*` - the delivery tooling inventory.
- `CLAUDE.md` and `CLAUDE.local.md` - anything stated there as fact (e.g. whether a test framework exists) can go stale; check the actual repo state (e.g. `package.json`'s `test` script, a real `test/` folder) rather than repeating a doc claim uncritically. If you find a stale claim like this, it's worth a callout in the page, same as the existing one about `CLAUDE.md`'s "no test framework" line.
- `git log -1 --format='%h %ad' --date=short` and `node -e "console.log(require('./package.json').version)"` - for the masthead version chip and footer commit/date.

Diff what you find against what the current [architecture.html](../../../architecture.html) says. Most
runs will only need small, targeted edits (a new env var row, a new intent, a new agent card, a
changed cost figure) - do not rewrite sections that have not changed.

## The design system already established - preserve it

Do not redesign the page. Reuse what's there:

- **Palette (both themes are already wired via `prefers-color-scheme`):** teal `--accent` = built and
  live in production; amber `--accent-2`, dashed = planned, not built; gray, dashed = a real but
  isolated/test-only lane (e.g. `telegram-echo-bot-test`). Keep this encoding consistent - don't
  introduce a fourth color without a reason, and don't repurpose teal/amber for anything else outside
  the confidence-ladder figure (which already has its own disambiguating caption).
- **Typography:** IBM Plex Sans (headings/body) + IBM Plex Mono (paths, env vars, code, numbers).
- **Layout:** sticky sidebar nav with scrollspy, one long page of anchored `<section>`s, a "hide
  planned" toggle that adds `.hide-planned` to `<body>`.
- **Diagrams:** hand-authored inline `<svg>` (rect/line/path/text only, `currentColor`/CSS-variable
  strokes, arrow `<marker>`s already defined once near the top of `<body>`) - no charting libraries.
  Reuse the existing `.box-live` / `.box-planned` / `.box-test` / `.box-danger` CSS classes on new
  boxes rather than inventing new box styles.
- **Schema and tooling entries** use the existing `<details class="schema-card">` and `.card` patterns
  - add new ones in the same shape rather than a new layout.
- **No em dashes anywhere in the generated prose** - the user's global typography rule bans them; use
  a plain hyphen-minus (`-`) for asides, exactly like the rest of this page already does.

## Steps

1. Re-read every source in the list above.
2. Update `architecture.html` with targeted `Edit` calls: new/changed source files in the Code Map
   table, new env vars or secrets in Config & Secrets, new or changed intents in Classification,
   changed deploy steps or triggers in Deploy Pipeline, new agents/skills/hooks in Tooling Inventory
   and Delivery Workflow, and any change to the planned design in the Planned: Memory Layer section.
   Bump the masthead version chip and the footer's commit hash and date.
3. Validate before reporting done, the same way this page was checked when first built:
   - Tag balance: a quick Python `re.findall` count of open vs. close tags for `div`, `section`,
     `table`, `tr`, `svg`, `details`, `figure` should match.
   - `node --check` on the contents of the `<script>` block.
   - `grep` for `—` (em dash) and fix any that slipped in.
   - Every relative `href="..."` (excluding `#anchors` and `http(s)://` links) should resolve to a
     real file - check with a shell loop and `[ -e "$path" ]`.
4. Report what changed section by section (not a full diff dump) and note anything you found stale
   in the source docs themselves (e.g. a CLAUDE.md claim that no longer matches the repo) so the user
   can decide whether to fix the doc, not just the generated page.

Do not commit. This repo's global policy is to never run `git commit` without an explicit
instruction - regenerate the file, validate it, and stop.
