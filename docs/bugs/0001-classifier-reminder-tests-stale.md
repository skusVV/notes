---
id: 0001-classifier-reminder-tests-stale
state: OPEN
severity: low
attempt: 0
max_attempts: 3
branch: fix/0001-classifier-reminder-tests-stale
acceptance: []
failures: []
---

# BUG-0001 - Two classifier reminder tests fail on `main`

> **OPEN.** Found 2026-11-01 while implementing spec 0013: `npm test` shows `2 failed | 190 passed`,
> and the same two fail on the base commit without any 0013 change.

## Symptom

`npm test` is not green. The tests in [classifier.reminder.spec.ts](../../test/classifier.reminder.spec.ts)
named "keeps confidence for a recurring reminder with no eventAt and no time of day" and "carries a
weekly rule and its stated time through to the draft" fail. Any pipeline run that treats a red suite
as a stop would block on this; today it is waved through by hand, which hides real regressions.

## Reproduction

`npm test -- test/classifier.reminder.spec.ts` on `main`. Expected today: those two tests fail.

## Root cause

Commit `6c763b2` ("Require quoted evidence before accepting a classifier recurrence") made the
classifier require a quoted `evidence` string before accepting a recurrence. The two fixtures in the
test file build a recurring reminder payload without `evidence`, so the classifier now (correctly)
drops the recurrence and the assertions fail. **The code is right, the fixtures are stale.** To be
confirmed by the implementer by reading the fixtures against `coerceItem` in
[classifier.service.ts](../../src/classifier/classifier.service.ts).

## Fix scope

- `test/classifier.reminder.spec.ts` - add a quoted `evidence` to the two recurring fixtures, drawn
  from the fixture's own text.

Out of bounds: any file under `src/`. If fixing the fixtures reveals that the classifier drops
something it should keep, stop and turn this into a spec.

## Invariants (must not break)

- The recurrence-evidence rule of `6c763b2` stays: a recurrence with no quoted evidence is still dropped.
- Absent fields stay absent; the classifier never invents a time or a rule.

## Acceptance criteria (locked at READY)

- **repro-fixed:** `npm test` exits 0 and reports no failed test in `classifier.reminder.spec.ts`.
- **evidence-rule-kept:** the same file contains a test that a recurring payload **without** `evidence`
  is still dropped to a one-off, and it passes.
- **no-src-change:** `git diff main...fix/0001-classifier-reminder-tests-stale -- src` is empty.

## Out of scope

Changing how the classifier decides recurrence, or the evidence rule itself.
