import test from 'node:test';
import assert from 'node:assert/strict';
import { Outcome } from './alert-state';
import { AttemptResult, syncWithRetries } from './ingester';

const attempt = (outcome: Outcome, hasSleepToday = false): AttemptResult => ({
  outcome, hasSleepToday, days: 0, activities: 0, error: null,
});

/** Plays back attempts in order, repeating the last one; counts tries and pauses. */
async function run(plan: AttemptResult[], maxAttempts: number) {
  const seen: number[] = [];
  let pauses = 0;
  const results = await syncWithRetries(
    async (n) => { seen.push(n); return plan[Math.min(n, plan.length) - 1]; },
    maxAttempts,
    async () => { pauses++; },
  );
  return { results, seen, pauses };
}

test('no sleep yet: exactly maxAttempts tries, a pause between each', async () => {
  const r = await run([attempt('success', false)], 3);
  assert.deepEqual(r.seen, [1, 2, 3]);
  assert.equal(r.pauses, 2);
});
test('sleep on the first try: exactly one try, no pause', async () => {
  const r = await run([attempt('success', true)], 5);
  assert.deepEqual(r.seen, [1]);
  assert.equal(r.pauses, 0);
});
test('rejected key: one try, never retried', async () => {
  const r = await run([attempt('auth_rejected')], 5);
  assert.deepEqual(r.seen, [1]);
});
test('Garmin down: stops at maxAttempts', async () => {
  const r = await run([attempt('transient')], 5);
  assert.equal(r.results.length, 5);
  assert.equal(r.pauses, 4);
});
test('transient then sleep: stops on the good try', async () => {
  const r = await run([attempt('transient'), attempt('success', false), attempt('success', true)], 5);
  assert.deepEqual(r.results.map((a) => a.outcome), ['transient', 'success', 'success']);
});
