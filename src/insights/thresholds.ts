/**
 * Every threshold the insight detectors use (spec 0026), in one place so a tuning change is one
 * edit here and never a hunt through the detectors.
 */

/** Values a 7-day window needs before it counts as a norm. */
export const MIN_VALUES_7 = 5;
/** Values a 30-day window needs before it counts as a norm. */
export const MIN_VALUES_30 = 20;
/** Days in the long norm window. */
export const NORM_WINDOW_LONG = 30;
/** Days in the short norm window. */
export const NORM_WINDOW_SHORT = 7;

/** readiness: resting HR at or above the 30-day norm plus this is a bad signal. */
export const READINESS_RHR_DELTA = 3;
/** readiness: sleep below this share of Garmin's sleep need is a bad signal. */
export const READINESS_SLEEP_NEED_SHARE = 0.85;
/** readiness: body battery after sleep at or below this share of its 30-day norm is a bad signal. */
export const READINESS_BATTERY_SHARE = 0.7;
/** readiness: fewer available signals than this means no readiness line. */
export const READINESS_MIN_SIGNALS = 2;

/** rhr-warning: today and yesterday each at or above the 7-day norm plus this. */
export const RHR_WARNING_DELTA = 5;

/** load-recovery: yesterday's load at or above this multiple of the median training day. */
export const LOAD_HEAVY_FACTOR = 1.5;
/** load-recovery: training days the median needs. */
export const LOAD_MIN_TRAINING_DAYS = 5;
/** load-recovery: resting HR at or above the 30-day norm plus this counts as poor recovery. */
export const LOAD_RHR_DELTA = 3;

/** sleep-debt: summed (need - sleep) over 7 nights at or above this, in minutes. */
export const SLEEP_DEBT_MINUTES = 180;

/** sleep-depth: deep sleep, REM or awakenings off the 30-day norm by at least this share. */
export const SLEEP_DEPTH_DEVIATION = 0.25;
/** sleep-depth cause: yesterday's high-stress share at or above this multiple of its norm. */
export const DEPTH_STRESS_FACTOR = 1.5;
/** sleep-depth cause: a workout that ended after this local hour. */
export const DEPTH_LATE_WORKOUT_HOUR = 20;
/** sleep-depth cause: fell asleep at least this many minutes later than the 7-night median. */
export const DEPTH_LATE_SLEEP_MINUTES = 60;

/** stress-battery: yesterday's high-stress share at or above this multiple of the 30-day norm. */
export const STRESS_FACTOR = 1.5;
/** stress-battery: body battery after sleep at or below this share of its 30-day norm. */
export const BATTERY_SHARE = 0.7;

/** sleep-rhythm: a 7-night bedtime spread at or below this (minutes) is a steady rhythm. */
export const RHYTHM_GOOD_SPREAD = 30;
/** sleep-rhythm: a spread, or a weekend shift, at or above this (minutes) is drift. */
export const RHYTHM_DRIFT_MINUTES = 60;
/** sleep-rhythm: nights in the weekend-shift window. */
export const RHYTHM_WEEKEND_WINDOW = 14;
/** sleep-rhythm: weekend and weekday nights the shift needs. */
export const RHYTHM_MIN_WEEKEND_NIGHTS = 2;
export const RHYTHM_MIN_WEEKDAY_NIGHTS = 5;

/** calories: the 7-day average changed by at least this share against the 7 days before. */
export const CALORIES_CHANGE = 0.1;

/** intensity-week: the weekly goal when Garmin has none (WHO's 150 minutes). */
export const INTENSITY_DEFAULT_GOAL = 150;

/** streak: the series lengths that earn a line. */
export const STREAK_MILESTONES: readonly number[] = [3, 5, 7, 10, 14, 21, 30];
/** streak: a series at least this long that broke yesterday gets a soft line. */
export const STREAK_BROKEN_MIN = 5;

/** info: days of history the facts need (of the 30, or 28 for weekly steps). */
export const INFO_MIN_DAYS = 20;
/** info: a weekday needs this many days for "best weekday". */
export const INFO_MIN_PER_WEEKDAY = 2;

/** No-repeat: days a trend waits before the same key shows again. */
export const REPEAT_TREND_DAYS = 7;
/** No-repeat: days a motivation or info fact waits before the same key shows again. */
export const REPEAT_MOTIVATION_DAYS = 14;
/** Journal keys older than this many days are dropped on write. */
export const JOURNAL_KEEP_DAYS = 30;

/** At most this many insights under the readiness line. */
export const MAX_INSIGHTS = 3;
