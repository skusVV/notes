import { describe, expect, it } from 'vitest';
import {
  bedtimeMinutes,
  detectCalories,
  detectInfo,
  detectIntensityWeek,
  detectLoadRecovery,
  detectRecords,
  detectRhrWarning,
  detectSleepDebt,
  detectSleepDepth,
  detectSleepRhythm,
  detectStreak,
  detectStressBattery,
} from '../../src/insights/detectors';
import { Insight } from '../../src/insights/insights.types';
import { bedtime, h } from './history';

/** Every number a line claims is in its template. */
function expectConsistent(insight: Insight | null): void {
  expect(insight).not.toBeNull();
  for (const number of insight!.numbers) {
    expect(insight!.template).toContain(number);
  }
  expect(insight!.template).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(insight!.template).not.toMatch(/\n/);
}

describe('rhr-warning (priority 1)', () => {
  // Norm = median of the 7 days before yesterday (back 2..8).
  const base = () => h().range(2, 8, { restingHr: 50 });

  it('fires when today and yesterday are each at the norm + 5', () => {
    const insight = detectRhrWarning(base().set(0, { restingHr: 55 }).set(1, { restingHr: 56 }).build());
    expectConsistent(insight);
    expect(insight).toMatchObject({ id: 'rhr-warning', key: 'rhr-warning', kind: 'warning', priority: 1 });
    expect(insight!.numbers).toEqual(['+5', '2']);
    expect(insight!.template).toContain('сигнал навантаження');
    expect(insight!.template).toContain('не діагноз');
  });

  it('does not fire one below the threshold on either day', () => {
    expect(detectRhrWarning(base().set(0, { restingHr: 54 }).set(1, { restingHr: 60 }).build())).toBeNull();
    expect(detectRhrWarning(base().set(0, { restingHr: 60 }).set(1, { restingHr: 54 }).build())).toBeNull();
  });

  it('is silent with fewer than 5 norm values, or a null day', () => {
    const thin = h().range(2, 5, { restingHr: 50 }).set(0, { restingHr: 60 }).set(1, { restingHr: 60 });
    expect(detectRhrWarning(thin.build())).toBeNull();
    expect(detectRhrWarning(base().set(0, { restingHr: 60 }).build())).toBeNull();
    expect(detectRhrWarning(base().set(0, { restingHr: null }).set(1, { restingHr: 60 }).build())).toBeNull();
  });

  it('counts the raised days and names data-backed companions only', () => {
    const history = h()
      .range(3, 8, { restingHr: 50 })
      .set(2, { restingHr: 56 })
      .set(1, { restingHr: 56 })
      .set(0, { restingHr: 57, hrvLastNightAvg: 40, hrvBaselineBalancedLow: 45 });
    const insight = detectRhrWarning(history.build());
    expectConsistent(insight);
    expect(insight!.numbers).toEqual(['+7', '3']);
    expect(insight!.template).toContain('HRV нижче базової лінії');
    // No respiration data: no respiration companion.
    expect(insight!.template).not.toContain('дихання');
  });
});

describe('load-recovery (priority 2)', () => {
  /** Five training days in the 30 before yesterday, each with load 100. */
  const trained = () => {
    const b = h();
    for (const back of [3, 5, 7, 9, 11]) {
      b.activity(back, '18:00:00', { trainingLoad: 100 });
    }
    return b;
  };

  it('hard: yesterday >= 1.5x the median training day and HRV below baseline', () => {
    const history = trained()
      .activity(1, '08:00:00', { trainingLoad: 90 })
      .activity(1, '18:00:00', { trainingLoad: 60 })
      .set(0, { hrvLastNightAvg: 40, hrvBaselineBalancedLow: 50 });
    const insight = detectLoadRecovery(history.build(), false);
    expectConsistent(insight);
    expect(insight).toMatchObject({ key: 'load-recovery:hard', priority: 2, kind: 'warning' });
    expect(insight!.numbers).toEqual(['150', '100', '40']);
    expect(insight!.template).toContain('легкий день');
  });

  it('hard via resting HR at the 30-day norm + 3 when HRV is fine', () => {
    const history = trained()
      .activity(1, '08:00:00', { trainingLoad: 150 })
      .range(1, 30, { restingHr: 50 })
      .set(0, { restingHr: 53 });
    const insight = detectLoadRecovery(history.build(), false);
    expectConsistent(insight);
    expect(insight!.numbers).toEqual(['150', '100', '53']);
  });

  it('not hard just under 1.5x, with good recovery, or with only 4 training days', () => {
    const low = trained().activity(1, '08:00:00', { trainingLoad: 149 }).set(0, { hrvLastNightAvg: 40, hrvBaselineBalancedLow: 50 });
    expect(detectLoadRecovery(low.build(), false)).toBeNull();

    const recovered = trained().activity(1, '08:00:00', { trainingLoad: 200 }).set(0, { hrvLastNightAvg: 55, hrvBaselineBalancedLow: 50 });
    expect(detectLoadRecovery(recovered.build(), false)).toBeNull();

    const few = h().set(0, { hrvLastNightAvg: 40, hrvBaselineBalancedLow: 50 }).activity(1, '08:00:00', { trainingLoad: 500 });
    for (const back of [3, 5, 7, 9]) {
      few.activity(back, '18:00:00', { trainingLoad: 100 });
    }
    expect(detectLoadRecovery(few.build(), false)).toBeNull();
  });

  it('good: green readiness and HRV above the balanced upper bound', () => {
    const history = h().set(0, { hrvLastNightAvg: 75, hrvBaselineBalancedUpper: 70 }).build();
    const insight = detectLoadRecovery(history, true);
    expectConsistent(insight);
    expect(insight).toMatchObject({ key: 'load-recovery:good' });
    expect(insight!.template).toContain('інтенсиву');
    expect(detectLoadRecovery(history, false)).toBeNull();
    expect(detectLoadRecovery(h().set(0, { hrvLastNightAvg: 70, hrvBaselineBalancedUpper: 70 }).build(), true)).toBeNull();
    expect(detectLoadRecovery(h().set(0, { hrvLastNightAvg: 75 }).build(), true)).toBeNull();
  });
});

describe('sleep-debt (priority 3)', () => {
  /** Seven nights (back 0..6) with a need of 480 min and these deficits. */
  const nights = (deficits: number[]) => {
    const b = h();
    deficits.forEach((deficit, back) => b.set(back, { sleepNeedMinutes: 480, sleepSeconds: (480 - deficit) * 60 }));
    return b.build();
  };

  it('fires at 180 minutes over 7 nights, shown as hours and minutes', () => {
    const insight = detectSleepDebt(nights([30, 30, 30, 30, 30, 30, 30]));
    expectConsistent(insight);
    expect(insight!.numbers).toEqual(['3 год 30 хв']);
    expect(detectSleepDebt(nights([30, 30, 30, 30, 30, 30, 0]))).not.toBeNull();
  });

  it('does not fire at 179', () => {
    expect(detectSleepDebt(nights([30, 30, 30, 30, 30, 30, -1]))).toBeNull();
  });

  it('needs 5 nights with both fields; a missing need is no night, never 0', () => {
    const b = h();
    for (const back of [0, 1, 2, 3]) {
      b.set(back, { sleepNeedMinutes: 480, sleepSeconds: 300 * 60 });
    }
    b.set(4, { sleepSeconds: 100 * 60 });
    expect(detectSleepDebt(b.build())).toBeNull();
  });
});

describe('sleep-depth (priority 4)', () => {
  const normal = () => h().range(1, 30, { sleepDeepSeconds: 90 * 60, sleepRemSeconds: 100 * 60, sleepAwakeCount: 4 });

  it('fires at 25% off the 30-day norm and shows "X хв проти звичних Y"', () => {
    const insight = detectSleepDepth(normal().set(0, { sleepDeepSeconds: 67.5 * 60 }).build());
    expectConsistent(insight);
    expect(insight).toMatchObject({ key: 'sleep-depth:deep', priority: 4 });
    expect(insight!.template).toContain('68 хв проти звичних 90 хв');
    expect(insight!.template).not.toContain('збіглося');
  });

  it('does not fire just inside 25%', () => {
    expect(detectSleepDepth(normal().set(0, { sleepDeepSeconds: 68 * 60 }).build())).toBeNull();
  });

  it('picks the largest deviation (awakenings counted, not minutes)', () => {
    const insight = detectSleepDepth(
      normal().set(0, { sleepDeepSeconds: 60 * 60, sleepAwakeCount: 10 }).build(),
    );
    expect(insight!.key).toBe('sleep-depth:awake');
    expect(insight!.template).toContain('10 проти звичних 4');
  });

  it('is silent with fewer than 20 norm nights, or no value today', () => {
    expect(detectSleepDepth(h().range(1, 19, { sleepDeepSeconds: 5400 }).set(0, { sleepDeepSeconds: 1000 }).build())).toBeNull();
    expect(detectSleepDepth(normal().build())).toBeNull();
  });

  it('names only causes that are in the data, as a coincidence', () => {
    const history = normal()
      .set(0, { sleepDeepSeconds: 40 * 60 })
      .range(2, 30, { stressHighShare: 0.1 })
      .set(1, { stressHighShare: 0.15 })
      .activity(1, '19:30:00', { durationSec: 45 * 60 });
    const insight = detectSleepDepth(history.build());
    expectConsistent(insight);
    expect(insight!.template).toContain('високим стресом учора');
    expect(insight!.template).toContain('пізнім тренуванням');
    expect(insight!.template).toContain('збіг');
    expect(insight!.template).not.toContain('навантаженням');
    expect(insight!.template).not.toContain('засинанням');
  });

  it('a workout that ended before 20:00 is no cause', () => {
    const history = normal().set(0, { sleepDeepSeconds: 40 * 60 }).activity(1, '18:00:00', { durationSec: 3600 });
    expect(detectSleepDepth(history.build())!.template).not.toContain('тренуванням');
  });
});

describe('stress-battery (priority 5)', () => {
  it('stress alone: yesterday at 1.5x the 30-day norm share', () => {
    const insight = detectStressBattery(h().range(2, 30, { stressHighShare: 0.1 }).set(1, { stressHighShare: 0.15 }).build());
    expectConsistent(insight);
    expect(insight!.numbers).toEqual(['15%', '10%']);
  });

  it('battery alone: at 70% of the norm', () => {
    const insight = detectStressBattery(h().range(1, 30, { bodyBatteryMax: 80 }).set(0, { bodyBatteryMax: 56 }).build());
    expectConsistent(insight);
    expect(insight!.numbers).toEqual(['56', '80']);
  });

  it('both make one linked line', () => {
    const history = h()
      .range(2, 30, { stressHighShare: 0.1, bodyBatteryMax: 80 })
      .set(1, { stressHighShare: 0.2, bodyBatteryMax: 80 })
      .set(0, { bodyBatteryMax: 40 });
    const insight = detectStressBattery(history.build());
    expectConsistent(insight);
    expect(insight!.numbers).toEqual(['20%', '10%', '40', '80']);
    expect(insight!.template).toContain('тож');
  });

  it('not at the edges, and silent without a norm', () => {
    expect(detectStressBattery(h().range(2, 30, { stressHighShare: 0.1 }).set(1, { stressHighShare: 0.14 }).build())).toBeNull();
    expect(detectStressBattery(h().range(1, 30, { bodyBatteryMax: 80 }).set(0, { bodyBatteryMax: 57 }).build())).toBeNull();
    expect(detectStressBattery(h().range(2, 15, { stressHighShare: 0.1 }).set(1, { stressHighShare: 0.5 }).build())).toBeNull();
    expect(detectStressBattery(h().range(1, 30, { bodyBatteryMax: 80 }).build())).toBeNull();
  });
});

describe('sleep-rhythm (priority 6)', () => {
  it('bedtimes are anchored at noon, so midnight does not break the spread', () => {
    expect(bedtimeMinutes('2026-11-24T23:50:00')).toBe(710);
    expect(bedtimeMinutes('2026-11-25T00:20:00')).toBe(740);
    expect(bedtimeMinutes(null)).toBeNull();
  });

  it('23:50 and 00:20 is a 30-minute spread: steady', () => {
    const b = h();
    for (let back = 0; back < 7; back += 1) {
      b.set(back, { sleepStartLocal: bedtime(b, back, back % 2 ? '23:50' : '00:20') });
    }
    const insight = detectSleepRhythm(b.build());
    expectConsistent(insight);
    expect(insight).toMatchObject({ key: 'sleep-rhythm:good', kind: 'trend' });
    expect(insight!.numbers).toEqual(['23:50', '0:20']);
    expect(insight!.template).toContain('о 23:50');
  });

  it('a 60-minute spread is drift; 31-59 is nothing', () => {
    const drift = h();
    for (let back = 0; back < 7; back += 1) {
      drift.set(back, { sleepStartLocal: bedtime(drift, back, back === 3 ? '00:30' : '23:30') });
    }
    expect(detectSleepRhythm(drift.build())!.key).toBe('sleep-rhythm:drift');

    const middle = h();
    for (let back = 0; back < 7; back += 1) {
      middle.set(back, { sleepStartLocal: bedtime(middle, back, back === 3 ? '00:15' : '23:30') });
    }
    expect(detectSleepRhythm(middle.build())).toBeNull();
  });

  it('weekend shift: Saturday and Sunday wake-ups an hour later than weekdays', () => {
    // Today is Wednesday 2026-11-25. Only 4 of the last 7 nights have data, so the spread is not
    // decided; the 14-night window has 2 weekend and 5+ weekday nights.
    const b = h();
    for (let back = 0; back < 14; back += 1) {
      if (back >= 1 && back <= 3) {
        continue;
      }
      const date = b.date(back);
      const day = new Date(`${date}T12:00:00Z`).getUTCDay();
      const weekend = day === 0 || day === 6;
      b.set(back, { sleepStartLocal: bedtime(b, back, weekend ? '00:40' : '23:30') });
    }
    const insight = detectSleepRhythm(b.build());
    expectConsistent(insight);
    expect(insight!.key).toBe('sleep-rhythm:drift');
    expect(insight!.numbers).toEqual(['1 год 10 хв']);
    expect(insight!.template).toContain('пізніше');
  });

  it('silent with too few nights', () => {
    const b = h();
    for (let back = 0; back < 4; back += 1) {
      b.set(back, { sleepStartLocal: bedtime(b, back, '23:00') });
    }
    expect(detectSleepRhythm(b.build())).toBeNull();
  });
});

describe('calories (priority 7)', () => {
  const weeks = (last: number, previous: number, field: 'caloriesActive' | 'caloriesTotal' = 'caloriesActive') =>
    h().range(1, 7, { [field]: last }).range(8, 14, { [field]: previous }).build();

  it('up 20%: average, previous and the change', () => {
    const insight = detectCalories(weeks(600, 500));
    expectConsistent(insight);
    expect(insight).toMatchObject({ key: 'calories:up', kind: 'trend', priority: 7 });
    expect(insight!.numbers).toEqual(['600', '500', '+20%']);
  });

  it('down is its own key; totals use thousands spacing', () => {
    const insight = detectCalories(weeks(2000, 2500, 'caloriesTotal'));
    expect(insight!.key).toBe('calories:down');
    expect(insight!.numbers).toEqual(['2 000', '2 500', '-20%']);
  });

  it('exactly 10% fires, just under does not', () => {
    expect(detectCalories(weeks(550, 500))).not.toBeNull();
    expect(detectCalories(weeks(549, 500))).toBeNull();
  });

  it('needs 5 and 5 days', () => {
    expect(detectCalories(h().range(1, 4, { caloriesActive: 900 }).range(8, 14, { caloriesActive: 500 }).build())).toBeNull();
  });
});

describe('intensity-week (priority 8)', () => {
  // Wednesday: the week so far is Monday (back 2) and Tuesday (back 1).
  it('not closed yet: minutes, goal, what is left and the pace to Sunday', () => {
    const insight = detectIntensityWeek(
      h().range(1, 2, { intensityModerate: 30, intensityVigorous: 10, intensityGoal: 150 }).build(),
    );
    expectConsistent(insight);
    expect(insight).toMatchObject({ key: 'intensity-week:left', kind: 'trend' });
    // 2 x (30 + 2 x 10) = 100 of 150; 50 left over Wed..Sun = 10 a day.
    expect(insight!.numbers).toEqual(['100', '150', '50', '10']);
  });

  it('closed: a once-a-week key', () => {
    const insight = detectIntensityWeek(
      h().range(1, 2, { intensityModerate: 60, intensityVigorous: 10, intensityGoal: 150 }).build(),
    );
    expect(insight!.key).toBe('intensity-week:done:2026-W48');
    expect(insight!.numbers).toEqual(['160', '150']);
  });

  it('no Garmin goal: 150', () => {
    const insight = detectIntensityWeek(h().range(1, 2, { intensityModerate: 10, intensityVigorous: 0 }).build());
    expect(insight!.numbers).toEqual(['20', '150', '130', '26']);
  });

  it('never on Monday, and never with a gap in the week', () => {
    expect(detectIntensityWeek(h('2026-11-23').range(1, 7, { intensityModerate: 30, intensityVigorous: 0 }).build())).toBeNull();
    expect(detectIntensityWeek(h().set(1, { intensityModerate: 30, intensityVigorous: 0 }).build())).toBeNull();
    expect(detectIntensityWeek(h().range(1, 2, { intensityModerate: 30, intensityVigorous: null }).build())).toBeNull();
  });
});

describe('streak (priority 9)', () => {
  const met = { steps: 11000, stepsGoal: 10000 };
  const missed = { steps: 9000, stepsGoal: 10000 };

  it('fires on milestones, each with its own key', () => {
    const three = detectStreak(h().range(1, 3, met).set(4, missed).build());
    expectConsistent(three);
    expect(three).toMatchObject({ key: 'streak:steps:3', kind: 'motivation', priority: 9 });
    expect(detectStreak(h().range(1, 5, met).set(6, missed).build())!.key).toBe('streak:steps:5');
  });

  it('no line between milestones', () => {
    expect(detectStreak(h().range(1, 4, met).set(5, missed).build())).toBeNull();
  });

  it('a series of 5+ that broke yesterday gets a soft line; 4 does not', () => {
    const broken = detectStreak(h().set(1, missed).range(2, 6, met).build());
    expectConsistent(broken);
    expect(broken!.key).toBe('streak:broken');
    expect(broken!.numbers).toEqual(['5']);
    expect(detectStreak(h().set(1, missed).range(2, 5, met).build())).toBeNull();
  });

  it('an unknown day (no goal) ends nothing and starts nothing', () => {
    expect(detectStreak(h().set(1, { steps: 12000 }).range(2, 4, met).build())).toBeNull();
  });
});

describe('record (priority 10)', () => {
  it('HRV today above every value of the 30 days before', () => {
    const records = detectRecords(h().range(1, 30, { hrvLastNightAvg: 50 }).set(0, { hrvLastNightAvg: 61 }).build());
    expect(records.map((r) => r.key)).toEqual(['record:hrv']);
    expectConsistent(records[0]);
  });

  it('steps and floors yesterday; equal is no record', () => {
    const records = detectRecords(
      h().range(2, 30, { steps: 8000, floorsUp: 10 }).set(1, { steps: 12500, floorsUp: 10 }).build(),
    );
    expect(records.map((r) => r.key)).toEqual(['record:steps']);
    expect(records[0].numbers).toEqual(['12 500']);
  });

  it('needs 20 days of history', () => {
    expect(detectRecords(h().range(1, 19, { hrvLastNightAvg: 50 }).set(0, { hrvLastNightAvg: 90 }).build())).toEqual([]);
  });
});

describe('info (priority 11)', () => {
  it('offers each fact the history supports, in rotation order', () => {
    const history = h()
      .range(0, 30, (back) => ({
        steps: back % 7 === 0 ? 12000 : 8000,
        floorsUp: 10,
        caloriesActive: 500,
        sleepSeconds: 7 * 3600,
      }))
      .build();
    const facts = detectInfo(history);
    expect(facts.map((f) => f.key)).toEqual([
      'info:steps-week',
      'info:sleep-avg',
      'info:floors-30',
      'info:active-calories-30',
      'info:best-weekday',
    ]);
    for (const fact of facts) {
      expectConsistent(fact);
      expect(fact.kind).toBe('motivation');
    }
    expect(facts[1].numbers).toEqual(['7 год']);
    expect(facts[2].numbers).toEqual(['300']);
    // back % 7 === 0 is a Wednesday (today), so yesterday-ending windows see Wednesdays at 12 000.
    expect(facts[4].template).toContain('середах');
  });

  it('nothing with thin history', () => {
    expect(detectInfo(h().range(0, 10, { steps: 8000, floorsUp: 3, caloriesActive: 400, sleepSeconds: 25000 }).build())).toEqual([]);
  });
});
