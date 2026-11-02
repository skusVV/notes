import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, SyncState } from './alert-state';

const ok: SyncState = { alertState: 'ok', alertedAt: null, expiryWarnedFor: null };
const opt = { renudgeDays: 7, expiryWarnDays: 14, keyExpiresOn: null };

test('first rejection alerts once, second run is silent', () => {
  const a = decide(ok, 'auth_rejected', '2026-11-02', opt);
  assert.deepEqual(a.messages, ['down']);
  assert.equal(decide(a.next, 'auth_rejected', '2026-11-03', opt).messages.length, 0);
});
test('re-nudge after RENUDGE_DAYS', () => {
  const a = decide(ok, 'auth_rejected', '2026-11-02', opt);
  assert.deepEqual(decide(a.next, 'auth_rejected', '2026-11-09', opt).messages, ['renudge']);
});
test('transient never alerts or changes state', () => {
  const r = decide(ok, 'transient', '2026-11-02', opt);
  assert.equal(r.messages.length, 0);
  assert.deepEqual(r.next, ok);
});
test('recovery once after alert', () => {
  const a = decide(ok, 'auth_rejected', '2026-11-02', opt);
  const r = decide(a.next, 'success', '2026-11-03', opt);
  assert.deepEqual(r.messages, ['recovery']);
  assert.equal(r.next.alertState, 'ok');
  assert.equal(decide(r.next, 'success', '2026-11-04', opt).messages.length, 0);
});
test('expiry heads-up once per key, re-armed by a new date', () => {
  const o = { ...opt, keyExpiresOn: '2026-11-10' };
  const a = decide(ok, 'success', '2026-11-02', o);
  assert.deepEqual(a.messages, ['expiry']);
  assert.equal(decide(a.next, 'success', '2026-11-03', o).messages.length, 0);
  assert.deepEqual(decide(a.next, 'success', '2026-11-03', { ...o, keyExpiresOn: '2027-11-02' }).messages, []);
  assert.deepEqual(decide(a.next, 'success', '2027-10-25', { ...o, keyExpiresOn: '2027-11-02' }).messages, ['expiry']);
});
test('no heads-up when expiry is far away', () => {
  assert.equal(decide(ok, 'success', '2026-11-02', { ...opt, keyExpiresOn: '2027-11-02' }).messages.length, 0);
});
