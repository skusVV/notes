/**
 * Pure formatting for the Garmin digest sections (spec 0018). No Nest, no clock, no Firestore: a
 * value in, a string out, so every rule here is pinned by unit tests.
 *
 * Only numbers from the documents and comparisons against **Garmin's own** numbers (the step goal,
 * the HRV baseline). No thresholds of our own and no verdict words - the one translated word is
 * Garmin's own sleep qualifier.
 */

/** Cells in every bar. */
const BAR_CELLS = 10;

/**
 * Exactly 10 cells: `round(value / goal * 10)` green, the rest white, capped at 10 when the goal is
 * beaten (the number beside the bar shows the real value). No goal, or a goal of 0 or less: no bar.
 */
export function progressBar(value: number, goal: number | null | undefined): string | null {
  if (goal === null || goal === undefined || !Number.isFinite(goal) || goal <= 0) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }

  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((value / goal) * BAR_CELLS)));
  return '🟩'.repeat(filled) + '⬜'.repeat(BAR_CELLS - filled);
}

/**
 * Where last night's HRV sits against Garmin's balanced baseline `[low, upper]`, as the text that
 * follows `HRV: V мс, `:
 *
 * - in range: `у діапазоні 55-70  🟢  55 ░░░░●░░░░░ 70`, the marker at
 *   `round((v - low) / (upper - low) * 9)`;
 * - below: `нижче діапазону 55-70  🟠  ⬇ 55 ░░░░░░░░░░ 70` (no marker, the arrow on the low side);
 * - above: `вище діапазону 55-70  🟠  55 ░░░░░░░░░░ 70 ⬆` (the arrow on the high side).
 *
 * Missing bounds, or `upper <= low` (broken data), return null: the caller shows the number alone,
 * with no bar and no colour, and nothing is ever divided by zero. The colour only means "inside /
 * outside Garmin's baseline", never a health verdict.
 */
export function hrvRangeBar(
  value: number,
  low: number | null | undefined,
  upper: number | null | undefined,
): string | null {
  if (
    low === null ||
    low === undefined ||
    upper === null ||
    upper === undefined ||
    !Number.isFinite(value) ||
    !Number.isFinite(low) ||
    !Number.isFinite(upper) ||
    upper <= low
  ) {
    return null;
  }

  const lo = formatNumber(low);
  const hi = formatNumber(upper);
  const range = `${lo}-${hi}`;

  if (value < low) {
    return `нижче діапазону ${range}  🟠  ⬇ ${lo} ${'░'.repeat(BAR_CELLS)} ${hi}`;
  }
  if (value > upper) {
    return `вище діапазону ${range}  🟠  ${lo} ${'░'.repeat(BAR_CELLS)} ${hi} ⬆`;
  }

  const marker = Math.round(((value - low) / (upper - low)) * (BAR_CELLS - 1));
  const cells = Array.from({ length: BAR_CELLS }, (_, i) => (i === marker ? '●' : '░')).join('');
  return `у діапазоні ${range}  🟢  ${lo} ${cells} ${hi}`;
}

/** `45 хв`, `1 год 5 хв`, `2 год`. Seconds are dropped; under a minute is `<1 хв`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) {
    return '<1 хв';
  }

  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes} хв`;
  }
  if (minutes === 0) {
    return `${hours} год`;
  }
  return `${hours} год ${minutes} хв`;
}

/** Garmin `activityType.typeKey` (stored as `activities/{id}.type`) to a Ukrainian label. */
const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  running: 'Біг',
  walking: 'Ходьба',
  cycling: 'Велосипед',
  strength_training: 'Силова',
  hiking: 'Похід',
  swimming: 'Плавання',
  yoga: 'Йога',
  breathwork: 'Дихання',
  // Variants seen in the owner's real data (2026-11-24): pool and open-water swims, indoor and
  // virtual rides, kayaking.
  lap_swimming: 'Плавання',
  open_water_swimming: 'Плавання',
  road_biking: 'Велосипед',
  indoor_cycling: 'Велосипед',
  virtual_ride: 'Велосипед',
  treadmill_running: 'Біг',
  kayaking_v2: 'Каяк',
};

/** The label for an activity type. Unknown or missing is `Тренування` - the raw key never shows. */
export function activityLabel(typeKey: string | null | undefined): string {
  if (typeof typeKey !== 'string') {
    return 'Тренування';
  }
  return ACTIVITY_LABELS[typeKey] ?? 'Тренування';
}

/** Garmin's own sleep-score qualifier, translated. */
const SLEEP_QUALIFIERS: Readonly<Record<string, string>> = {
  EXCELLENT: 'відмінно',
  GOOD: 'добре',
  FAIR: 'посередньо',
  POOR: 'погано',
};

/**
 * Garmin's sleep qualifier in Ukrainian, case-insensitive. Anything else is null, so an unknown key
 * is left out rather than shown as raw English.
 */
export function sleepQualifierLabel(key: string | null | undefined): string | null {
  if (typeof key !== 'string') {
    return null;
  }
  return SLEEP_QUALIFIERS[key.trim().toUpperCase()] ?? null;
}

/** `8 200` - whole number, a plain space between thousands. */
export function formatSteps(steps: number): string {
  return formatNumber(steps).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** A whole number for display. Garmin's values are already whole; this only guards against `62.4`. */
export function formatNumber(value: number): string {
  return String(Math.round(value));
}
