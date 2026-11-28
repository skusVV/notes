import { describe, expect, it } from 'vitest';
import { KIND, PRIORITY } from '../../src/insights/detectors';
import { Insight, InsightId } from '../../src/insights/insights.types';
import { dateWindow, daysBetween, median, shiftDate, windowBefore } from '../../src/insights/norms';
import { mayShow, nextJournal, planInsights, rankInsights } from '../../src/insights/rank';
import { computeReadiness } from '../../src/insights/readiness';
import { ALL_NORMAL_LINE } from '../../src/insights/templates';
import { h, TODAY } from './history';

function make(id: InsightId, key: string = id, deviation = 0): Insight {
  return { id, key, kind: KIND[id], priority: PRIORITY[id], deviation, template: key, numbers: [] };
}

const EMPTY = { shown: {} };

describe('norms', () => {
  it('median of odd and even lists, null for none', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('calendar windows that never include their own day, across months and DST dates', () => {
    expect(windowBefore('2026-11-02', 3)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(dateWindow('2026-03-30', 2)).toEqual(['2026-03-29', '2026-03-30']);
    // 2026-10-25 is the Kyiv fall-back day: still exactly one calendar day.
    expect(shiftDate('2026-10-26', -1)).toBe('2026-10-25');
    expect(daysBetween('2026-10-20', '2026-10-27')).toBe(7);
  });
});

describe('readiness', () => {
  /** A month of norms: resting HR 50, body battery 80. */
  const base = () => h().range(1, 30, { restingHr: 50, bodyBatteryMax: 80 });

  it('🟢 when every available signal is fine', () => {
    const r = computeReadiness(
      base().set(0, { restingHr: 51, hrvLastNightAvg: 60, hrvBaselineBalancedLow: 50, sleepSeconds: 8 * 3600, sleepNeedMinutes: 480, bodyBatteryMax: 85 }).build(),
      false,
    );
    expect(r?.level).toBe('green');
    expect(r?.template.startsWith('🟢')).toBe(true);
    expect(r?.numbers).toEqual([]);
  });

  it('🟡 with one bad signal, named with its value', () => {
    const r = computeReadiness(
      base().set(0, { restingHr: 50, hrvLastNightAvg: 41, hrvBaselineBalancedLow: 50 }).build(),
      false,
    );
    expect(r?.level).toBe('yellow');
    expect(r?.template.startsWith('🟡')).toBe(true);
    expect(r?.template).toContain('HRV 41 мс');
    expect(r?.numbers).toEqual(['41']);
  });

  it('🔴 with two bad signals', () => {
    const r = computeReadiness(
      base().set(0, { restingHr: 53, sleepSeconds: 5 * 3600, sleepNeedMinutes: 480 }).build(),
      false,
    );
    expect(r?.level).toBe('red');
    expect(r?.numbers).toEqual(['53', '5 год']);
  });

  it('an active rhr-warning makes it 🔴 even with no other bad signal', () => {
    const r = computeReadiness(base().set(0, { restingHr: 50, bodyBatteryMax: 80 }).build(), true);
    expect(r?.level).toBe('red');
    expect(r?.template.startsWith('🔴')).toBe(true);
  });

  it('fewer than 2 available signals: no line', () => {
    expect(computeReadiness(h().set(0, { hrvLastNightAvg: 30, hrvBaselineBalancedLow: 50 }).build(), false)).toBeNull();
    // Resting HR without a month of norm is not available.
    expect(
      computeReadiness(h().range(1, 10, { restingHr: 50 }).set(0, { restingHr: 70, hrvLastNightAvg: 60, hrvBaselineBalancedLow: 50 }).build(), false),
    ).toBeNull();
  });

  it('thresholds: resting HR at norm + 3 is bad, + 2 is not; battery at 70% is bad', () => {
    const at = (fields: Record<string, number>) =>
      computeReadiness(base().set(0, { hrvLastNightAvg: 60, hrvBaselineBalancedLow: 50, restingHr: 50, bodyBatteryMax: 80, ...fields }).build(), false)?.level;
    expect(at({ restingHr: 53 })).toBe('yellow');
    expect(at({ restingHr: 52 })).toBe('green');
    expect(at({ bodyBatteryMax: 56 })).toBe('yellow');
    expect(at({ bodyBatteryMax: 57 })).toBe('green');
  });
});

describe('rankInsights', () => {
  it('orders by priority, then by deviation within a priority', () => {
    const ranked = rankInsights(
      [make('calories'), make('sleep-depth', 'sleep-depth:rem', 0.3), make('sleep-depth', 'sleep-depth:deep', 0.6), make('rhr-warning')],
      EMPTY,
      TODAY,
    );
    expect(ranked.map((i) => i.key)).toEqual(['rhr-warning', 'sleep-depth:deep', 'sleep-depth:rem']);
  });

  it('shows at most 3', () => {
    const ranked = rankInsights(
      [make('streak'), make('calories', 'calories:up'), make('stress-battery'), make('sleep-debt'), make('rhr-warning')],
      EMPTY,
      TODAY,
    );
    expect(ranked).toHaveLength(3);
    expect(ranked.map((i) => i.id)).toEqual(['rhr-warning', 'sleep-debt', 'stress-battery']);
  });

  it('an ordinary day (nothing in 1-8) shows one fact: streak before record before info', () => {
    const ranked = rankInsights([make('info', 'info:sleep-avg'), make('record', 'record:hrv'), make('streak', 'streak:steps:3')], EMPTY, TODAY);
    expect(ranked.map((i) => i.key)).toEqual(['streak:steps:3']);
    expect(rankInsights([make('info', 'info:sleep-avg'), make('record', 'record:hrv')], EMPTY, TODAY).map((i) => i.key)).toEqual(['record:hrv']);
  });
});

describe('no-repeat rule', () => {
  const yesterday = shiftDate(TODAY, -1);

  it('a warning repeats the next day', () => {
    expect(mayShow(make('sleep-debt'), { shown: { 'sleep-debt': yesterday } }, TODAY)).toBe(true);
  });

  it('a trend waits 7 days under the same key', () => {
    const trend = make('calories', 'calories:up');
    expect(mayShow(trend, { shown: { 'calories:up': shiftDate(TODAY, -6) } }, TODAY)).toBe(false);
    expect(mayShow(trend, { shown: { 'calories:up': shiftDate(TODAY, -7) } }, TODAY)).toBe(true);
    // Another variant is another key.
    expect(mayShow(make('calories', 'calories:down'), { shown: { 'calories:up': yesterday } }, TODAY)).toBe(true);
  });

  it('motivation waits 14 days; streak milestones are different keys', () => {
    const three = make('streak', 'streak:steps:3');
    expect(mayShow(three, { shown: { 'streak:steps:3': shiftDate(TODAY, -13) } }, TODAY)).toBe(false);
    expect(mayShow(three, { shown: { 'streak:steps:3': shiftDate(TODAY, -14) } }, TODAY)).toBe(true);
    expect(mayShow(make('streak', 'streak:steps:5'), { shown: { 'streak:steps:3': shiftDate(TODAY, -2) } }, TODAY)).toBe(true);
  });

  it('blocked candidates drop out of the ranking', () => {
    const ranked = rankInsights(
      [make('streak', 'streak:steps:3'), make('info', 'info:sleep-avg')],
      { shown: { 'streak:steps:3': yesterday } },
      TODAY,
    );
    expect(ranked.map((i) => i.key)).toEqual(['info:sleep-avg']);
  });

  it('the journal records today and drops keys older than 30 days', () => {
    const next = nextJournal(
      { shown: { old: shiftDate(TODAY, -31), edge: shiftDate(TODAY, -30), recent: yesterday } },
      ['calories:up'],
      TODAY,
    );
    expect(next).toEqual({ shown: { edge: shiftDate(TODAY, -30), recent: yesterday, 'calories:up': TODAY } });
  });
});

describe('planInsights', () => {
  it('readiness first (marker split off), then insights; the shown keys go to the journal', () => {
    const history = h()
      .range(1, 30, { restingHr: 50, bodyBatteryMax: 80 })
      .set(0, { restingHr: 50, bodyBatteryMax: 80, hrvLastNightAvg: 60, hrvBaselineBalancedLow: 50 })
      .range(1, 3, { steps: 11000, stepsGoal: 10000 })
      .set(4, { steps: 9000, stepsGoal: 10000 })
      .build();
    const plan = planInsights(history, EMPTY);
    expect(plan.lines[0]).toMatchObject({ id: 'readiness', marker: '🟢' });
    expect(plan.lines[0].template.startsWith('🟢')).toBe(false);
    expect(plan.lines.map((l) => l.id)).toContain('streak:steps:3');
    expect(plan.shownKeys).toContain('streak:steps:3');
    expect(plan.shownKeys).not.toContain('readiness');
  });

  it('everything shown recently: "Усе в межах твоєї норми."', () => {
    const history = h().range(1, 3, { steps: 11000, stepsGoal: 10000 }).set(4, { steps: 9000, stepsGoal: 10000 }).build();
    const plan = planInsights(history, { shown: { 'streak:steps:3': shiftDate(TODAY, -1) } });
    expect(plan.lines).toEqual([{ id: 'all-normal', template: ALL_NORMAL_LINE, numbers: [], fixed: true }]);
    expect(plan.shownKeys).toEqual([]);
  });

  it('a month of history and nothing to say: the norm line', () => {
    const plan = planInsights(h().range(0, 30, { steps: 5000 }).build(), {
      shown: Object.fromEntries(
        ['info:steps-week', 'info:best-weekday'].map((key) => [key, shiftDate(TODAY, -1)]),
      ),
    });
    expect(plan.lines.map((l) => l.template)).toEqual([ALL_NORMAL_LINE]);
  });

  it('no data at all: no lines (the section hides)', () => {
    expect(planInsights(h().build(), EMPTY).lines).toEqual([]);
  });
});
