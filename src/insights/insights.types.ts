/**
 * The shared insights layer (spec 0026, first slice of 0021): pure types, no Nest, no Firestore, no
 * network, no clock. The digest section reads the history and hands it in; `/ask` (0020) can reuse
 * the same detectors later.
 */

export type InsightId =
  | 'rhr-warning'
  | 'load-recovery'
  | 'sleep-debt'
  | 'sleep-depth'
  | 'stress-battery'
  | 'sleep-rhythm'
  | 'calories'
  | 'intensity-week'
  | 'streak'
  | 'record'
  | 'info';

export type InsightKind = 'warning' | 'trend' | 'motivation';

export interface Insight {
  id: InsightId;
  /** `id` or `id:variant` - what the no-repeat journal is keyed by. */
  key: string;
  kind: InsightKind;
  /** 1..11, lower ranks higher (spec 0026, decision 5). */
  priority: number;
  /** Relative deviation from the norm; breaks ties between equal priorities (higher first). */
  deviation: number;
  /** The ready Ukrainian line, without a bullet. */
  template: string;
  /** Substrings a rewritten line must contain verbatim, or the template is kept. */
  numbers: string[];
}

export interface Readiness {
  level: 'green' | 'yellow' | 'red';
  /** Starts with 🟢 / 🟡 / 🔴. */
  template: string;
  numbers: string[];
}

/**
 * One `users/{id}/health_daily/{date}` document, flattened to the fields the detectors use. Every
 * value is null when Garmin had none - never 0 (field names are the morning job's `Wellness`).
 */
export interface DayHealth {
  date: string;
  sleepSeconds: number | null;
  sleepDeepSeconds: number | null;
  sleepRemSeconds: number | null;
  sleepAwakeCount: number | null;
  /** Wall-clock `YYYY-MM-DDTHH:mm:ss` the night's sleep started. */
  sleepStartLocal: string | null;
  sleepNeedMinutes: number | null;
  sleepAvgRespiration: number | null;
  hrvLastNightAvg: number | null;
  hrvBaselineBalancedLow: number | null;
  hrvBaselineBalancedUpper: number | null;
  restingHr: number | null;
  /** Share of the day in high stress, a fraction 0..1 as the morning job stores it. */
  stressHighShare: number | null;
  bodyBatteryMax: number | null;
  steps: number | null;
  stepsGoal: number | null;
  floorsUp: number | null;
  caloriesTotal: number | null;
  caloriesActive: number | null;
  intensityModerate: number | null;
  intensityVigorous: number | null;
  intensityGoal: number | null;
}

/** One `users/{id}/activities/{id}` document, the fields the detectors use. */
export interface ActivityRecord {
  /** `YYYY-MM-DD HH:mm:ss` local wall clock. */
  startTimeLocal: string;
  durationSec: number | null;
  trainingLoad: number | null;
}

/** Everything the detectors see: 31 days up to and including `today`. */
export interface HealthHistory {
  /** The digest's local date, `YYYY-MM-DD`. */
  today: string;
  /** By date. A date with no document is simply absent. */
  days: Record<string, DayHealth>;
  activities: ActivityRecord[];
}

/** `users/{id}/system/digestInsights`. */
export interface InsightJournal {
  shown: Record<string, string>;
}
