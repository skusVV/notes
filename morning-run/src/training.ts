import { Activity, DayTraining, Wellness } from './garmin-client';

/** Day rollup of already-stored activities, so "a heavy strength week" is one cheap query. Pure. */
export function trainingByDay(activities: Activity[]): Map<string, DayTraining> {
  const out = new Map<string, DayTraining>();
  for (const a of activities) {
    const date = a.startTimeLocal?.slice(0, 10);
    if (!date) continue;
    const d = out.get(date) ?? emptyDay();
    d.count++;
    d.durationSec += a.durationSec ?? 0;
    d.trainingLoad = Math.round((d.trainingLoad + (a.trainingLoad ?? 0)) * 10) / 10;
    if (a.type === 'strength_training') {
      d.strengthSessions++;
      d.strengthSets += a.sets ?? 0;
      d.strengthReps += a.reps ?? 0;
    }
    d.aerobicEffectMax = max(d.aerobicEffectMax, a.trainingEffectAerobic);
    d.anaerobicEffectMax = max(d.anaerobicEffectMax, a.trainingEffectAnaerobic);
    out.set(date, d);
  }
  return out;
}

/** Attach `training` to every day. A day with no activities gets zeros: "did nothing" is a fact. */
export function withTraining(days: Map<string, Wellness>, activities: Activity[]): Map<string, Wellness> {
  const byDay = trainingByDay(activities);
  for (const [date, w] of days) w.training = byDay.get(date) ?? emptyDay();
  return days;
}

const emptyDay = (): DayTraining => ({
  count: 0, durationSec: 0, trainingLoad: 0, strengthSessions: 0, strengthSets: 0, strengthReps: 0,
  aerobicEffectMax: null, anaerobicEffectMax: null,
});
const max = (a: number | null, b: number | null) => (b === null ? a : a === null ? b : Math.max(a, b));
