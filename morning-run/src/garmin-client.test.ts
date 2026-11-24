import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSleep, mergeHrv, mergeSummaries, normalizeActivity, normalizeHrZones, windows, Wellness } from './garmin-client';

test('windows split a long range into <=28 day chunks with no gaps', () => {
  const w = windows('2026-09-03', '2026-11-02'); // 61 days
  assert.equal(w.length, 3);
  assert.deepEqual(w[0], ['2026-09-03', '2026-09-30']);
  assert.equal(w[2][1], '2026-11-02');
  assert.deepEqual(windows('2026-11-01', '2026-11-02'), [['2026-11-01', '2026-11-02']]);
});

test('merge groups fields, keeps absent ones null and combines sources by date', () => {
  const m = new Map<string, Wellness>();
  mergeSleep(m, [{
    calendarDate: '2026-11-02', sleepTimeSeconds: 25000, sleepStartTimestampLocal: 1793572448000,
    averageSpO2Value: 95, sleepScores: { overall: { value: 81, qualifierKey: 'GOOD' } },
    sleepNeed: { baseline: 480, actual: 495, trainingFeedback: 'NO_CHANGE' },
  }]);
  mergeHrv(m, { hrvSummaries: [{ calendarDate: '2026-11-02', lastNightAvg: 55, status: 'BALANCED', baseline: { balancedLow: 48 } }] });
  mergeSummaries(m, { data: [{
    calendarDate: '2026-11-02', heartRate: { restingValue: 52 },
    movement: { steps: { value: 9000, goal: 7000 }, floorsAscended: { value: 12.4 } },
    calories: { burnedTotal: 2205 }, stress: { avgLevel: 20, lowStressProportion: 0.051 },
  }] });
  const w = m.get('2026-11-02')!;
  assert.equal(w.sleep.seconds, 25000);
  assert.equal(w.sleep.score, 81);
  assert.equal(w.sleep.needMinutes, 495);
  assert.equal(w.sleep.startLocal, '2026-11-01T22:34:08');
  assert.equal(w.hrv.lastNightAvg, 55);
  assert.equal(w.hrv.baselineBalancedLow, 48);
  assert.equal(w.heart.resting, 52);
  assert.equal(w.movement.steps, 9000);
  assert.equal(w.movement.floorsUp, 12);
  assert.equal(w.calories.total, 2205);
  assert.equal(w.stress.lowShare, 0.05);
  assert.equal(w.stress.max, null);
  assert.equal(w.bodyBattery.charged, null);
  assert.equal(w.spo2.avg, null);
  assert.equal(w.training, undefined);
});

test('empty and malformed bodies write nothing', () => {
  const m = new Map<string, Wellness>();
  mergeSleep(m, []);
  mergeHrv(m, {});
  mergeSummaries(m, null);
  assert.equal(m.size, 0);
});

test('activity carries zones, effect and load; strength gets sets and reps only', () => {
  const a = normalizeActivity({
    activityId: 7, activityType: { typeKey: 'strength_training' }, duration: 1201.86, calories: 165.4,
    aerobicTrainingEffect: 1.399999976, activityTrainingLoad: 18.0413, totalSets: 5, totalReps: 40,
    hrTimeInZone_1: 465.213, hrTimeInZone_2: 623.645, hrTimeInZone_3: 107, hrTimeInZone_4: 0, hrTimeInZone_5: 0,
  })!;
  assert.deepEqual(a.hrZoneSeconds, [465, 624, 107, 0, 0]);
  assert.equal(a.trainingEffectAerobic, 1.4);
  assert.equal(a.trainingLoad, 18);
  assert.equal(a.durationSec, 1202);
  assert.equal(a.sets, 5);
  assert.equal(a.reps, 40);
  const run = normalizeActivity({ activityId: 8, activityType: { typeKey: 'running' }, totalSets: 3 })!;
  assert.equal(run.sets, null);
  assert.equal(run.hrZoneSeconds, null);
});

test('hr zones normalize to floors 1..5', () => {
  const z = normalizeHrZones([{ sport: 'DEFAULT', maxHeartRateUsed: 188, zone1Floor: 94, zone2Floor: 113, zone3Floor: 132, zone4Floor: 150, zone5Floor: 169 }]);
  assert.deepEqual(z[0].zoneFloors, [94, 113, 132, 150, 169]);
  assert.equal(z[0].maxHr, 188);
  assert.deepEqual(normalizeHrZones(null), []);
});

test('activity distance is null for non-distance activities', () => {
  const a = normalizeActivity({ activityId: 1, activityType: { typeKey: 'strength_training' }, distance: 0, averageHR: 120 })!;
  assert.equal(a.distanceKm, null);
  assert.equal(a.avgHr, 120);
  assert.equal(normalizeActivity({ distance: 5 }), null);
  assert.equal(normalizeActivity({ activityId: 2, distance: 5000 })!.distanceKm, 5);
});
