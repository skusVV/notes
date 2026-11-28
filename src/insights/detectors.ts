import { DateTime } from 'luxon';
import { ActivityRecord, HealthHistory, Insight, InsightId, InsightKind } from './insights.types';
import {
  atLeast,
  atMost,
  dateWindow,
  daysBetween,
  isoWeek,
  mean,
  median,
  normOver,
  relativeDeviation,
  shiftDate,
  valueOn,
  valuesOver,
  weekday,
  windowBefore,
} from './norms';
import {
  DEPTH_CAUSES,
  DepthMetric,
  InfoFact,
  RHR_COMPANIONS,
  RecordMetric,
  TemplateText,
  caloriesText,
  infoText,
  intensityDoneText,
  intensityLeftText,
  loadGoodText,
  loadHardText,
  recordText,
  rhrWarningText,
  rhythmGoodText,
  rhythmSpreadText,
  rhythmWeekendText,
  sleepDebtText,
  sleepDepthText,
  streakBrokenText,
  streakText,
  stressBatteryText,
} from './templates';
import * as T from './thresholds';

/**
 * One detector per row of the spec 0026 table. Each is pure and returns its candidate lines (none
 * when the condition is false or the data is too thin - never a weak insight). Ranking and the
 * no-repeat rule live in `rank.ts`.
 *
 * Dates: sleep, HRV, resting HR and body battery are read from `today` (Garmin files the night
 * under the wake-up date); steps, floors, calories, stress, intensity and workouts from yesterday.
 * Norm windows never include the day they are compared with.
 */

/** Fixed priorities, decision 5. */
export const PRIORITY: Record<InsightId, number> = {
  'rhr-warning': 1,
  'load-recovery': 2,
  'sleep-debt': 3,
  'sleep-depth': 4,
  'stress-battery': 5,
  'sleep-rhythm': 6,
  calories: 7,
  'intensity-week': 8,
  streak: 9,
  record: 10,
  info: 11,
};

export const KIND: Record<InsightId, InsightKind> = {
  'rhr-warning': 'warning',
  'load-recovery': 'warning',
  'sleep-debt': 'warning',
  'sleep-depth': 'warning',
  'stress-battery': 'warning',
  'sleep-rhythm': 'trend',
  calories: 'trend',
  'intensity-week': 'trend',
  streak: 'motivation',
  record: 'motivation',
  info: 'motivation',
};

function insight(id: InsightId, key: string, deviation: number, text: TemplateText): Insight {
  return {
    id,
    key,
    kind: KIND[id],
    priority: PRIORITY[id],
    deviation: Number.isFinite(deviation) ? deviation : 0,
    template: text.template,
    numbers: text.numbers,
  };
}

export function yesterdayOf(history: HealthHistory): string {
  return shiftDate(history.today, -1);
}

/** The 30-day resting-HR norm before today, or null with too little data. */
export function restingHrNorm30(history: HealthHistory): number | null {
  return normOver(history, windowBefore(history.today, T.NORM_WINDOW_LONG), 'restingHr', T.MIN_VALUES_30);
}

/** Today's HRV is below Garmin's balanced baseline; null when either is missing. */
export function hrvBelowBaseline(history: HealthHistory): boolean | null {
  const hrv = valueOn(history, history.today, 'hrvLastNightAvg');
  const low = valueOn(history, history.today, 'hrvBaselineBalancedLow');
  return hrv === null || low === null ? null : hrv < low;
}

// ---------------------------------------------------------------- 1 rhr-warning

export function detectRhrWarning(history: HealthHistory): Insight | null {
  const today = history.today;
  const yesterday = yesterdayOf(history);
  const rToday = valueOn(history, today, 'restingHr');
  const rYesterday = valueOn(history, yesterday, 'restingHr');
  // The 7 days before yesterday, so neither compared day is in its own norm.
  const norm = normOver(history, windowBefore(yesterday, T.NORM_WINDOW_SHORT), 'restingHr', T.MIN_VALUES_7);
  if (rToday === null || rYesterday === null || norm === null) {
    return null;
  }
  const limit = norm + T.RHR_WARNING_DELTA;
  if (rToday < limit || rYesterday < limit) {
    return null;
  }

  // Consecutive raised days ending today (at least the two compared).
  let days = 2;
  for (let date = shiftDate(yesterday, -1); days < T.NORM_WINDOW_LONG; date = shiftDate(date, -1)) {
    const value = valueOn(history, date, 'restingHr');
    if (value === null || value < limit) {
      break;
    }
    days += 1;
  }

  const companions: string[] = [];
  const respiration = valueOn(history, today, 'sleepAvgRespiration');
  const respirationNorm = normOver(
    history,
    windowBefore(today, T.NORM_WINDOW_LONG),
    'sleepAvgRespiration',
    T.MIN_VALUES_30,
  );
  if (respiration !== null && respirationNorm !== null && respiration > respirationNorm) {
    companions.push(RHR_COMPANIONS.respiration);
  }
  if (hrvBelowBaseline(history) === true) {
    companions.push(RHR_COMPANIONS.hrv);
  }

  return insight(
    'rhr-warning',
    'rhr-warning',
    relativeDeviation(rToday, norm),
    rhrWarningText(rToday - norm, days, companions),
  );
}

// ---------------------------------------------------------------- 2 load-recovery

/** Summed `trainingLoad` per local date, only for days with at least one known load. */
export function loadByDay(activities: readonly ActivityRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const activity of activities) {
    if (activity.trainingLoad === null || !Number.isFinite(activity.trainingLoad)) {
      continue;
    }
    const date = activity.startTimeLocal.slice(0, 10);
    out.set(date, (out.get(date) ?? 0) + activity.trainingLoad);
  }
  return out;
}

/** Yesterday's load and the median training-day load of the 30 days before it. */
export function loadComparison(history: HealthHistory): { load: number; median: number } | null {
  const yesterday = yesterdayOf(history);
  const byDay = loadByDay(history.activities);
  const load = byDay.get(yesterday);
  if (load === undefined) {
    return null;
  }
  const window = new Set(windowBefore(yesterday, T.NORM_WINDOW_LONG));
  const sums = [...byDay.entries()].filter(([date]) => window.has(date)).map(([, sum]) => sum);
  if (sums.length < T.LOAD_MIN_TRAINING_DAYS) {
    return null;
  }
  const norm = median(sums);
  return norm === null ? null : { load, median: norm };
}

export function detectLoadRecovery(history: HealthHistory, readinessGreen: boolean): Insight | null {
  const today = history.today;
  const hrv = valueOn(history, today, 'hrvLastNightAvg');
  const rhr = valueOn(history, today, 'restingHr');

  const load = loadComparison(history);
  if (load && load.median > 0 && atLeast(load.load, T.LOAD_HEAVY_FACTOR * load.median)) {
    const hrvLow = hrvBelowBaseline(history) === true;
    const rhrNorm = restingHrNorm30(history);
    const rhrHigh = rhr !== null && rhrNorm !== null && rhr >= rhrNorm + T.LOAD_RHR_DELTA;
    if (hrvLow || rhrHigh) {
      return insight(
        'load-recovery',
        'load-recovery:hard',
        load.load / load.median - 1,
        loadHardText(load.load, load.median, hrvLow ? hrv : null, hrvLow ? null : rhr),
      );
    }
  }

  const upper = valueOn(history, today, 'hrvBaselineBalancedUpper');
  if (readinessGreen && hrv !== null && upper !== null && hrv > upper) {
    return insight('load-recovery', 'load-recovery:good', relativeDeviation(hrv, upper), loadGoodText(hrv));
  }
  return null;
}

// ---------------------------------------------------------------- 3 sleep-debt

export function detectSleepDebt(history: HealthHistory): Insight | null {
  let debt = 0;
  let nights = 0;
  let need = 0;
  for (const date of dateWindow(history.today, T.NORM_WINDOW_SHORT)) {
    const sleep = valueOn(history, date, 'sleepSeconds');
    const needMinutes = valueOn(history, date, 'sleepNeedMinutes');
    if (sleep === null || needMinutes === null) {
      continue;
    }
    debt += needMinutes - sleep / 60;
    need += needMinutes;
    nights += 1;
  }
  if (nights < T.MIN_VALUES_7 || debt < T.SLEEP_DEBT_MINUTES) {
    return null;
  }
  return insight('sleep-debt', 'sleep-debt', need > 0 ? debt / need : 0, sleepDebtText(debt, nights));
}

// ---------------------------------------------------------------- 4 sleep-depth

/** `YYYY-MM-DDTHH:mm:ss` (or with a space) as minutes since the previous noon: 23:50 is 710, 00:20 is 740. */
export function bedtimeMinutes(startLocal: string | null | undefined): number | null {
  const match = /[T ](\d{2}):(\d{2})/.exec(startLocal ?? '');
  if (!match) {
    return null;
  }
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return (minutes - 720 + 1440) % 1440;
}

function bedtimeOn(history: HealthHistory, date: string): number | null {
  return bedtimeMinutes(history.days[date]?.sleepStartLocal);
}

function bedtimesOver(history: HealthHistory, dates: readonly string[]): Array<{ date: string; minutes: number }> {
  return dates
    .map((date) => ({ date, minutes: bedtimeOn(history, date) }))
    .filter((entry): entry is { date: string; minutes: number } => entry.minutes !== null);
}

/** Wall-clock end of an activity; the start when Garmin gave no duration. */
function activityEnd(activity: ActivityRecord): DateTime | null {
  const start = DateTime.fromFormat(activity.startTimeLocal, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  if (!start.isValid) {
    return null;
  }
  return activity.durationSec === null ? start : start.plus({ seconds: activity.durationSec });
}

/** The data-backed coincidences for a disturbed night - never a guessed cause. */
export function sleepDepthCauses(history: HealthHistory): string[] {
  const today = history.today;
  const yesterday = yesterdayOf(history);
  const causes: string[] = [];

  const share = valueOn(history, yesterday, 'stressHighShare');
  const shareNorm = normOver(history, windowBefore(yesterday, T.NORM_WINDOW_LONG), 'stressHighShare', T.MIN_VALUES_30);
  if (share !== null && shareNorm !== null && shareNorm > 0 && atLeast(share, T.DEPTH_STRESS_FACTOR * shareNorm)) {
    causes.push(DEPTH_CAUSES.stress);
  }

  const lateFrom = DateTime.fromISO(`${yesterday}T${String(T.DEPTH_LATE_WORKOUT_HOUR).padStart(2, '0')}:00:00`, {
    zone: 'UTC',
  });
  const late = history.activities.some((activity) => {
    if (activity.startTimeLocal.slice(0, 10) !== yesterday) {
      return false;
    }
    const end = activityEnd(activity);
    return end !== null && end > lateFrom;
  });
  if (late) {
    causes.push(DEPTH_CAUSES.lateWorkout);
  }

  const load = loadComparison(history);
  if (load && load.median > 0 && atLeast(load.load, T.LOAD_HEAVY_FACTOR * load.median)) {
    causes.push(DEPTH_CAUSES.load);
  }

  const bedtime = bedtimeOn(history, today);
  const previous = bedtimesOver(history, windowBefore(today, T.NORM_WINDOW_SHORT)).map((entry) => entry.minutes);
  const usual = previous.length >= T.MIN_VALUES_7 ? median(previous) : null;
  if (bedtime !== null && usual !== null && bedtime - usual >= T.DEPTH_LATE_SLEEP_MINUTES) {
    causes.push(DEPTH_CAUSES.lateSleep);
  }

  return causes;
}

export function detectSleepDepth(history: HealthHistory): Insight | null {
  const today = history.today;
  const window = windowBefore(today, T.NORM_WINDOW_LONG);
  const metrics: Array<{ metric: DepthMetric; value: number | null; norm: number | null }> = [
    {
      metric: 'deep',
      value: minutesOf(valueOn(history, today, 'sleepDeepSeconds')),
      norm: minutesOf(normOver(history, window, 'sleepDeepSeconds', T.MIN_VALUES_30)),
    },
    {
      metric: 'rem',
      value: minutesOf(valueOn(history, today, 'sleepRemSeconds')),
      norm: minutesOf(normOver(history, window, 'sleepRemSeconds', T.MIN_VALUES_30)),
    },
    {
      metric: 'awake',
      value: valueOn(history, today, 'sleepAwakeCount'),
      norm: normOver(history, window, 'sleepAwakeCount', T.MIN_VALUES_30),
    },
  ];

  let best: { metric: DepthMetric; value: number; norm: number; deviation: number } | null = null;
  for (const { metric, value, norm } of metrics) {
    if (value === null || norm === null || norm <= 0) {
      continue;
    }
    const deviation = relativeDeviation(value, norm);
    if (atLeast(deviation, T.SLEEP_DEPTH_DEVIATION) && (!best || deviation > best.deviation)) {
      best = { metric, value, norm, deviation };
    }
  }
  if (!best) {
    return null;
  }
  return insight(
    'sleep-depth',
    `sleep-depth:${best.metric}`,
    best.deviation,
    sleepDepthText(best.metric, best.value, best.norm, sleepDepthCauses(history)),
  );
}

function minutesOf(seconds: number | null): number | null {
  return seconds === null ? null : seconds / 60;
}

// ---------------------------------------------------------------- 5 stress-battery

export function detectStressBattery(history: HealthHistory): Insight | null {
  const today = history.today;
  const yesterday = yesterdayOf(history);

  const share = valueOn(history, yesterday, 'stressHighShare');
  const shareNorm = normOver(history, windowBefore(yesterday, T.NORM_WINDOW_LONG), 'stressHighShare', T.MIN_VALUES_30);
  const stress =
    share !== null && shareNorm !== null && shareNorm > 0 && atLeast(share, T.STRESS_FACTOR * shareNorm)
      ? { share, norm: shareNorm }
      : null;

  const battery = valueOn(history, today, 'bodyBatteryMax');
  const batteryNorm = normOver(history, windowBefore(today, T.NORM_WINDOW_LONG), 'bodyBatteryMax', T.MIN_VALUES_30);
  const low =
    battery !== null && batteryNorm !== null && batteryNorm > 0 && atMost(battery, T.BATTERY_SHARE * batteryNorm)
      ? { value: battery, norm: batteryNorm }
      : null;

  if (!stress && !low) {
    return null;
  }
  const deviation = Math.max(
    stress ? stress.share / stress.norm - 1 : 0,
    low ? 1 - low.value / low.norm : 0,
  );
  return insight('stress-battery', 'stress-battery', deviation, stressBatteryText(stress, low));
}

// ---------------------------------------------------------------- 6 sleep-rhythm

export function detectSleepRhythm(history: HealthHistory): Insight | null {
  const week = bedtimesOver(history, dateWindow(history.today, T.NORM_WINDOW_SHORT));
  if (week.length >= T.MIN_VALUES_7) {
    const minutes = week.map((entry) => entry.minutes);
    const earliest = Math.min(...minutes);
    const latest = Math.max(...minutes);
    const spread = latest - earliest;
    if (spread <= T.RHYTHM_GOOD_SPREAD) {
      return insight(
        'sleep-rhythm',
        'sleep-rhythm:good',
        (T.RHYTHM_GOOD_SPREAD - spread) / T.RHYTHM_GOOD_SPREAD,
        rhythmGoodText(earliest + 720, latest + 720),
      );
    }
    if (spread >= T.RHYTHM_DRIFT_MINUTES) {
      return insight(
        'sleep-rhythm',
        'sleep-rhythm:drift',
        spread / T.RHYTHM_DRIFT_MINUTES - 1,
        rhythmSpreadText(earliest + 720, latest + 720),
      );
    }
  }

  const nights = bedtimesOver(history, dateWindow(history.today, T.RHYTHM_WEEKEND_WINDOW));
  const weekend = nights.filter((entry) => weekday(entry.date) >= 6).map((entry) => entry.minutes);
  const weekdays = nights.filter((entry) => weekday(entry.date) <= 5).map((entry) => entry.minutes);
  if (weekend.length < T.RHYTHM_MIN_WEEKEND_NIGHTS || weekdays.length < T.RHYTHM_MIN_WEEKDAY_NIGHTS) {
    return null;
  }
  const shift = (median(weekend) ?? 0) - (median(weekdays) ?? 0);
  if (Math.abs(shift) < T.RHYTHM_DRIFT_MINUTES) {
    return null;
  }
  return insight(
    'sleep-rhythm',
    'sleep-rhythm:drift',
    Math.abs(shift) / T.RHYTHM_DRIFT_MINUTES - 1,
    rhythmWeekendText(shift),
  );
}

// ---------------------------------------------------------------- 7 calories

export function detectCalories(history: HealthHistory): Insight | null {
  const yesterday = yesterdayOf(history);
  const last = dateWindow(yesterday, 7);
  const previous = dateWindow(shiftDate(yesterday, -7), 7);

  let best: { metric: 'total' | 'active'; average: number; previous: number; change: number } | null = null;
  for (const [metric, field] of [
    ['total', 'caloriesTotal'],
    ['active', 'caloriesActive'],
  ] as const) {
    const a = valuesOver(history, last, field);
    const b = valuesOver(history, previous, field);
    if (a.length < T.MIN_VALUES_7 || b.length < T.MIN_VALUES_7) {
      continue;
    }
    const average = mean(a) ?? 0;
    const before = mean(b) ?? 0;
    if (before <= 0) {
      continue;
    }
    const change = (average - before) / before;
    if (atLeast(Math.abs(change), T.CALORIES_CHANGE) && (!best || Math.abs(change) > Math.abs(best.change))) {
      best = { metric, average, previous: before, change };
    }
  }
  if (!best) {
    return null;
  }
  return insight(
    'calories',
    best.change > 0 ? 'calories:up' : 'calories:down',
    Math.abs(best.change),
    caloriesText(best.metric, best.average, best.previous, best.change),
  );
}

// ---------------------------------------------------------------- 8 intensity-week

export function detectIntensityWeek(history: HealthHistory): Insight | null {
  const today = history.today;
  const day = weekday(today);
  if (day <= 1) {
    // Monday: the week has not started yet (and 0 is a bad date).
    return null;
  }
  const yesterday = yesterdayOf(history);
  const week = dateWindow(yesterday, day - 1);

  let minutes = 0;
  let goal: number | null = null;
  for (const date of week) {
    const moderate = valueOn(history, date, 'intensityModerate');
    const vigorous = valueOn(history, date, 'intensityVigorous');
    if (moderate === null || vigorous === null) {
      // A gap would undercount the week: no line rather than a wrong one.
      return null;
    }
    minutes += moderate + 2 * vigorous;
    goal = valueOn(history, date, 'intensityGoal') ?? goal;
  }
  const target = goal !== null && goal > 0 ? goal : T.INTENSITY_DEFAULT_GOAL;

  if (minutes >= target) {
    return insight(
      'intensity-week',
      `intensity-week:done:${isoWeek(today)}`,
      minutes / target - 1,
      intensityDoneText(minutes, target),
    );
  }
  const left = target - minutes;
  const daysLeft = 8 - day; // today through Sunday
  const pace = Math.ceil(left / daysLeft);
  return insight('intensity-week', 'intensity-week:left', left / target, intensityLeftText(minutes, target, left, pace));
}

// ---------------------------------------------------------------- 9 streak

/** Whether the day's steps met its goal; null when either is unknown. */
function stepsMet(history: HealthHistory, date: string): boolean | null {
  const steps = valueOn(history, date, 'steps');
  const goal = valueOn(history, date, 'stepsGoal');
  return steps === null || goal === null || goal <= 0 ? null : steps >= goal;
}

function streakEndingAt(history: HealthHistory, end: string): number {
  let count = 0;
  for (let date = end; daysBetween(date, history.today) <= T.NORM_WINDOW_LONG; date = shiftDate(date, -1)) {
    if (stepsMet(history, date) !== true) {
      break;
    }
    count += 1;
  }
  return count;
}

export function detectStreak(history: HealthHistory): Insight | null {
  const yesterday = yesterdayOf(history);
  const met = stepsMet(history, yesterday);
  if (met === true) {
    const count = streakEndingAt(history, yesterday);
    if (!T.STREAK_MILESTONES.includes(count)) {
      return null;
    }
    return insight('streak', `streak:steps:${count}`, count / T.NORM_WINDOW_LONG, streakText(count));
  }
  if (met === false) {
    const count = streakEndingAt(history, shiftDate(yesterday, -1));
    if (count >= T.STREAK_BROKEN_MIN) {
      return insight('streak', 'streak:broken', 0, streakBrokenText(count));
    }
  }
  return null;
}

// ---------------------------------------------------------------- 10 record

export function detectRecords(history: HealthHistory): Insight[] {
  const today = history.today;
  const yesterday = yesterdayOf(history);
  const checks: Array<{ metric: RecordMetric; date: string; field: 'hrvLastNightAvg' | 'steps' | 'floorsUp' }> = [
    { metric: 'hrv', date: today, field: 'hrvLastNightAvg' },
    { metric: 'steps', date: yesterday, field: 'steps' },
    { metric: 'floors', date: yesterday, field: 'floorsUp' },
  ];

  const out: Insight[] = [];
  for (const { metric, date, field } of checks) {
    const value = valueOn(history, date, field);
    const previous = valuesOver(history, windowBefore(date, T.NORM_WINDOW_LONG), field);
    if (value === null || previous.length < T.MIN_VALUES_30) {
      continue;
    }
    const best = Math.max(...previous);
    if (value > best && value > 0) {
      out.push(insight('record', `record:${metric}`, best > 0 ? value / best - 1 : 0, recordText(metric, value)));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 11 info

/** Every fact the history supports, in rotation order; the no-repeat rule does the rotating. */
export function detectInfo(history: HealthHistory): Insight[] {
  const today = history.today;
  const yesterday = yesterdayOf(history);
  const month = dateWindow(yesterday, T.NORM_WINDOW_LONG);
  const out: Insight[] = [];
  const add = (fact: InfoFact, value: number, weekdayIndex?: number) =>
    out.push(insight('info', `info:${fact}`, 0, infoText(fact, value, weekdayIndex)));

  const steps28 = valuesOver(history, dateWindow(yesterday, 28), 'steps');
  if (steps28.length >= T.INFO_MIN_DAYS) {
    add('steps-week', Math.round((mean(steps28) ?? 0) * 7));
  }

  const sleep = valuesOver(history, dateWindow(today, T.NORM_WINDOW_LONG), 'sleepSeconds');
  if (sleep.length >= T.INFO_MIN_DAYS) {
    add('sleep-avg', mean(sleep) ?? 0);
  }

  const floors = valuesOver(history, month, 'floorsUp');
  if (floors.length >= T.INFO_MIN_DAYS) {
    add('floors-30', floors.reduce((sum, v) => sum + v, 0));
  }

  const active = valuesOver(history, month, 'caloriesActive');
  if (active.length >= T.INFO_MIN_DAYS) {
    add('active-calories-30', active.reduce((sum, v) => sum + v, 0));
  }

  const byWeekday = new Map<number, number[]>();
  let stepDays = 0;
  for (const date of month) {
    const value = valueOn(history, date, 'steps');
    if (value === null) {
      continue;
    }
    stepDays += 1;
    const list = byWeekday.get(weekday(date)) ?? [];
    list.push(value);
    byWeekday.set(weekday(date), list);
  }
  if (stepDays >= T.INFO_MIN_DAYS) {
    let best: { day: number; average: number } | null = null;
    for (const [day, values] of [...byWeekday.entries()].sort((a, b) => a[0] - b[0])) {
      if (values.length < T.INFO_MIN_PER_WEEKDAY) {
        continue;
      }
      const average = mean(values) ?? 0;
      if (!best || average > best.average) {
        best = { day, average };
      }
    }
    if (best) {
      add('best-weekday', Math.round(best.average), best.day);
    }
  }

  return out;
}
