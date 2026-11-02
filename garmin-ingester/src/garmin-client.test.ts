import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSleep, mergeHrv, mergeSummaries, normalizeActivity, windows, Wellness } from './garmin-client';

test('windows split a long range into <=28 day chunks with no gaps', () => {
  const w = windows('2026-09-03', '2026-11-02'); // 61 days
  assert.equal(w.length, 3);
  assert.deepEqual(w[0], ['2026-09-03', '2026-09-30']);
  assert.equal(w[2][1], '2026-11-02');
  assert.deepEqual(windows('2026-11-01', '2026-11-02'), [['2026-11-01', '2026-11-02']]);
});

test('merge keeps absent fields null and combines sources by date', () => {
  const m = new Map<string, Wellness>();
  mergeSleep(m, [{ calendarDate: '2026-11-02', sleepTimeSeconds: 25000, sleepScores: { overall: { value: 81 } } }]);
  mergeHrv(m, { hrvSummaries: [{ calendarDate: '2026-11-02', lastNightAvg: 55, status: 'BALANCED' }] });
  mergeSummaries(m, { data: [{ calendarDate: '2026-11-02', heartRate: { restingValue: 52 }, movement: { steps: { value: 9000, goal: 7000 } } }] });
  const w = m.get('2026-11-02')!;
  assert.equal(w.sleepSeconds, 25000);
  assert.equal(w.sleepScore, 81);
  assert.equal(w.hrvLastNightAvgMs, 55);
  assert.equal(w.restingHr, 52);
  assert.equal(w.steps, 9000);
  assert.equal(w.stressAvg, null);
  assert.equal(w.bodyBatteryCharged, null);
});

test('empty and malformed bodies write nothing', () => {
  const m = new Map<string, Wellness>();
  mergeSleep(m, []);
  mergeHrv(m, {});
  mergeSummaries(m, null);
  assert.equal(m.size, 0);
});

test('activity distance is null for non-distance activities', () => {
  const a = normalizeActivity({ activityId: 1, activityType: { typeKey: 'strength_training' }, distance: 0, averageHR: 120 })!;
  assert.equal(a.distanceKm, null);
  assert.equal(a.avgHr, 120);
  assert.equal(normalizeActivity({ distance: 5 }), null);
  assert.equal(normalizeActivity({ activityId: 2, distance: 5000 })!.distanceKm, 5);
});
