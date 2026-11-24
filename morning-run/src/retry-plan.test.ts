import test from 'node:test';
import assert from 'node:assert/strict';
import { finalOutcome, shouldRetry } from './retry-plan';

test('transient is retried', () => {
  assert.equal(shouldRetry('transient', false, 1, 5), true);
  assert.equal(shouldRetry('transient', true, 4, 5), true);
});
test('success without sleep for today is retried', () => {
  assert.equal(shouldRetry('success', false, 1, 5), true);
});
test('success with sleep for today stops', () => {
  assert.equal(shouldRetry('success', true, 1, 5), false);
});
test('auth_rejected stops at once, never retried', () => {
  assert.equal(shouldRetry('auth_rejected', false, 1, 5), false);
  assert.equal(shouldRetry('auth_rejected', true, 1, 5), false);
});
test('attempt == max stops whatever the outcome', () => {
  assert.equal(shouldRetry('transient', false, 5, 5), false);
  assert.equal(shouldRetry('success', false, 5, 5), false);
  assert.equal(shouldRetry('transient', false, 1, 1), false);
  assert.equal(shouldRetry('transient', false, 6, 5), false);
});

test('final outcome: rejected key wins', () => {
  assert.equal(finalOutcome(['transient', 'auth_rejected']), 'auth_rejected');
  assert.equal(finalOutcome(['auth_rejected']), 'auth_rejected');
});
test('final outcome: the last attempt decides between transient and success', () => {
  assert.equal(finalOutcome(['transient', 'transient', 'transient']), 'transient');
  assert.equal(finalOutcome(['transient', 'success']), 'success');
  assert.equal(finalOutcome(['success', 'transient']), 'transient');
});
test('final outcome: Garmin answered but no sleep is success, not transient', () => {
  // Outcomes carry no sleep flag: "no sleep yet" is an answered attempt, so it stays success.
  assert.equal(finalOutcome(['success', 'success', 'success']), 'success');
});
test('final outcome: no attempt at all is transient', () => {
  assert.equal(finalOutcome([]), 'transient');
});
