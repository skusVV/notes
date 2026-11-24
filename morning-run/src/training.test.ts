import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWellness, Wellness } from './garmin-client';
import { trainingByDay, withTraining } from './training';

const act = (o: Record<string, unknown>) => ({
  activityId: 1, type: 'running', startTimeLocal: '2026-11-02 09:14:35', startTimeUtc: null, durationSec: 3000,
  distanceKm: 8, avgHr: 150, maxHr: 170, calories: 600, trainingEffectAerobic: 3.7, trainingEffectAnaerobic: 0.1,
  trainingEffectLabel: null, trainingLoad: 116.6, hrZoneSeconds: null, steps: null, avgRespiration: null,
  bodyBatteryDelta: null, intensityModerateMin: null, intensityVigorousMin: null, sets: null, reps: null, ...o,
});

test('rollup sums a day and counts strength separately', () => {
  const m = trainingByDay([
    act({}),
    act({ activityId: 2, type: 'strength_training', durationSec: 1200, trainingLoad: 18, sets: 5, reps: 40, trainingEffectAerobic: 1.4, trainingEffectAnaerobic: 2.2 }),
    act({ activityId: 3, startTimeLocal: '2026-11-01 07:00:00' }),
  ]);
  const d = m.get('2026-11-02')!;
  assert.equal(d.count, 2);
  assert.equal(d.durationSec, 4200);
  assert.equal(d.trainingLoad, 134.6);
  assert.equal(d.strengthSessions, 1);
  assert.equal(d.strengthSets, 5);
  assert.equal(d.strengthReps, 40);
  assert.equal(d.aerobicEffectMax, 3.7);
  assert.equal(d.anaerobicEffectMax, 2.2);
  assert.equal(m.get('2026-11-01')!.count, 1);
});

test('a day without activities gets zeros, not a missing field', () => {
  const days = new Map<string, Wellness>([['2026-11-03', emptyWellness()]]);
  withTraining(days, [act({})]);
  const t = days.get('2026-11-03')!.training!;
  assert.equal(t.count, 0);
  assert.equal(t.aerobicEffectMax, null);
});
