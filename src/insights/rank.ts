import {
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
  yesterdayOf,
} from './detectors';
import { HealthHistory, Insight, InsightJournal, Readiness } from './insights.types';
import { daysBetween, windowBefore } from './norms';
import { computeReadiness } from './readiness';
import { ALL_NORMAL_LINE, READINESS_MARKERS } from './templates';
import * as T from './thresholds';

/**
 * Ranking, the no-repeat rule and the "ordinary day" choice (spec 0026, decisions 5-7 and 12).
 * Pure: the journal and the date come in, the lines and the next journal go out.
 */

/** Highest priority of the warnings and trends; anything above is motivation or info. */
const LAST_SIGNAL_PRIORITY = 8;

/**
 * Whether `insight` may show on `today` given when its key last showed. Warnings repeat daily while
 * true; trends wait {@link T.REPEAT_TREND_DAYS}, motivation and info {@link T.REPEAT_MOTIVATION_DAYS}.
 */
export function mayShow(insight: Insight, journal: InsightJournal, today: string): boolean {
  if (insight.kind === 'warning') {
    return true;
  }
  const last = journal.shown[insight.key];
  if (typeof last !== 'string') {
    return true;
  }
  const gap = daysBetween(last, today);
  if (!Number.isFinite(gap)) {
    return true;
  }
  return gap >= (insight.kind === 'trend' ? T.REPEAT_TREND_DAYS : T.REPEAT_MOTIVATION_DAYS);
}

/** Priority first (lower wins), then the larger deviation; stable otherwise. */
export function compareInsights(a: Insight, b: Insight): number {
  return a.priority - b.priority || b.deviation - a.deviation;
}

/**
 * The insights to show: the allowed candidates by rank, at most {@link T.MAX_INSIGHTS}. When no
 * warning or trend (priority 1-8) is among them, only the single best motivation or info fact.
 */
export function rankInsights(candidates: readonly Insight[], journal: InsightJournal, today: string): Insight[] {
  const allowed = candidates.filter((insight) => mayShow(insight, journal, today)).sort(compareInsights);
  const signals = allowed.some((insight) => insight.priority <= LAST_SIGNAL_PRIORITY);
  return allowed.slice(0, signals ? T.MAX_INSIGHTS : 1);
}

/** The journal after showing `keys` on `today`, with keys older than {@link T.JOURNAL_KEEP_DAYS} dropped. */
export function nextJournal(journal: InsightJournal, keys: readonly string[], today: string): InsightJournal {
  const shown: Record<string, string> = {};
  for (const [key, date] of Object.entries(journal.shown ?? {})) {
    const age = daysBetween(date, today);
    if (typeof date === 'string' && Number.isFinite(age) && age <= T.JOURNAL_KEEP_DAYS) {
      shown[key] = date;
    }
  }
  for (const key of keys) {
    shown[key] = today;
  }
  return { shown };
}

/** Every candidate the history supports today, before ranking. */
export function detectAll(history: HealthHistory): { readiness: Readiness | null; candidates: Insight[] } {
  const rhr = detectRhrWarning(history);
  const readiness = computeReadiness(history, rhr !== null);
  const single = [
    rhr,
    detectLoadRecovery(history, readiness?.level === 'green'),
    detectSleepDebt(history),
    detectSleepDepth(history),
    detectStressBattery(history),
    detectSleepRhythm(history),
    detectCalories(history),
    detectIntensityWeek(history),
    detectStreak(history),
  ].filter((insight): insight is Insight => insight !== null);
  return { readiness, candidates: [...single, ...detectRecords(history), ...detectInfo(history)] };
}

/** One line of the section before phrasing. */
export interface PlannedLine {
  /** Unique within the section: `readiness`, an insight key, or `all-normal`. */
  id: string;
  /** Prepended by code after phrasing (the readiness colour), never left to the model. */
  marker?: string;
  /** The text without the marker. */
  template: string;
  numbers: string[];
  /** A contract string that is never rewritten. */
  fixed?: boolean;
}

export interface InsightPlan {
  lines: PlannedLine[];
  /** The insight keys shown - what goes into the journal. */
  shownKeys: string[];
}

/**
 * The section's lines for today: readiness (when it can be computed), then up to three ranked
 * insights; with none left to show, `Усе в межах твоєї норми.` - but only when there is enough
 * history to know what the norm is. With nothing known at all, no lines (the section is hidden).
 */
export function planInsights(history: HealthHistory, journal: InsightJournal): InsightPlan {
  const { readiness, candidates } = detectAll(history);
  const ranked = rankInsights(candidates, journal, history.today);
  const lines: PlannedLine[] = [];

  if (readiness) {
    const marker = READINESS_MARKERS[readiness.level];
    lines.push({
      id: 'readiness',
      marker,
      template: readiness.template.slice(marker.length).trimStart(),
      numbers: readiness.numbers,
    });
  }
  for (const insight of ranked) {
    lines.push({ id: insight.key, template: insight.template, numbers: insight.numbers });
  }

  if (ranked.length === 0 && (candidates.length > 0 || knowsNorm(history))) {
    lines.push({ id: 'all-normal', template: ALL_NORMAL_LINE, numbers: [], fixed: true });
  }

  return { lines, shownKeys: ranked.map((insight) => insight.key) };
}

/** Whether today or yesterday has data and there is a month of history to call "normal". */
function knowsNorm(history: HealthHistory): boolean {
  const recent = history.days[history.today] !== undefined || history.days[yesterdayOf(history)] !== undefined;
  const month = windowBefore(history.today, T.NORM_WINDOW_LONG).filter((date) => history.days[date] !== undefined);
  return recent && month.length >= T.MIN_VALUES_30;
}
