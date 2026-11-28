/**
 * Shared fixture for the insight specs: a `HealthHistory` builder. Not a spec file, so vitest does
 * not collect it.
 */
import { ActivityRecord, DayHealth, HealthHistory } from '../../src/insights/insights.types';
import { shiftDate } from '../../src/insights/norms';

/** A Wednesday: yesterday is Tuesday, the week started on Monday 2026-11-23. */
export const TODAY = '2026-11-25';
export const YESTERDAY = '2026-11-24';

export function emptyDay(date: string): DayHealth {
  return {
    date,
    sleepSeconds: null,
    sleepDeepSeconds: null,
    sleepRemSeconds: null,
    sleepAwakeCount: null,
    sleepStartLocal: null,
    sleepNeedMinutes: null,
    sleepAvgRespiration: null,
    hrvLastNightAvg: null,
    hrvBaselineBalancedLow: null,
    hrvBaselineBalancedUpper: null,
    restingHr: null,
    stressHighShare: null,
    bodyBatteryMax: null,
    steps: null,
    stepsGoal: null,
    floorsUp: null,
    caloriesTotal: null,
    caloriesActive: null,
    intensityModerate: null,
    intensityVigorous: null,
    intensityGoal: null,
  };
}

/** A mutable history; `set` merges fields into a day, creating it. */
export class HistoryBuilder {
  readonly history: HealthHistory;

  constructor(today = TODAY) {
    this.history = { today, days: {}, activities: [] };
  }

  /** Days back from today: 0 is today, 1 yesterday. */
  date(back: number): string {
    return shiftDate(this.history.today, -back);
  }

  set(back: number, fields: Partial<DayHealth>): this {
    const date = this.date(back);
    this.history.days[date] = { ...(this.history.days[date] ?? emptyDay(date)), ...fields };
    return this;
  }

  /** The same fields on every day `from..to` back (inclusive), e.g. `range(1, 30, ...)`. */
  range(from: number, to: number, fields: Partial<DayHealth> | ((back: number) => Partial<DayHealth>)): this {
    for (let back = from; back <= to; back += 1) {
      this.set(back, typeof fields === 'function' ? fields(back) : fields);
    }
    return this;
  }

  activity(back: number, time: string, fields: Partial<ActivityRecord> = {}): this {
    this.history.activities.push({
      startTimeLocal: `${this.date(back)} ${time}`,
      durationSec: null,
      trainingLoad: null,
      ...fields,
    });
    return this;
  }

  build(): HealthHistory {
    return this.history;
  }
}

export const h = (today = TODAY) => new HistoryBuilder(today);

/** Sleep start `HH:mm` the evening before the wake-up day `back` (or just after midnight). */
export function bedtime(builder: HistoryBuilder, back: number, time: string): string {
  const [hours] = time.split(':').map(Number);
  // Before noon is after midnight, so it is on the wake-up date itself.
  const date = hours < 12 ? builder.date(back) : builder.date(back + 1);
  return `${date}T${time}:00`;
}
