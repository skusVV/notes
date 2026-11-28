import { DateTime } from 'luxon';
import { DayHealth, HealthHistory } from './insights.types';

/**
 * Norm helpers for the detectors (spec 0026): medians, calendar date windows and the minimum-data
 * rule. Pure - dates are `YYYY-MM-DD` strings moved with luxon `minus({ days })`, never minus 24
 * hours, so a DST change never shifts a window.
 */

/** The median, or null for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The arithmetic mean, or null for an empty list. */
export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** `date` moved by `days` calendar days (negative is back). */
export function shiftDate(date: string, days: number): string {
  const parsed = DateTime.fromISO(date, { zone: 'UTC' });
  if (!parsed.isValid) {
    return '';
  }
  return (days < 0 ? parsed.minus({ days: -days }) : parsed.plus({ days })).toISODate() ?? '';
}

/** Calendar days from `from` to `to` (positive when `to` is later). NaN for a bad date. */
export function daysBetween(from: string, to: string): number {
  const a = DateTime.fromISO(from, { zone: 'UTC' });
  const b = DateTime.fromISO(to, { zone: 'UTC' });
  if (!a.isValid || !b.isValid) {
    return Number.NaN;
  }
  return Math.round(b.diff(a, 'days').days);
}

/** ISO weekday of a date, 1 = Monday .. 7 = Sunday. 0 for a bad date. */
export function weekday(date: string): number {
  const parsed = DateTime.fromISO(date, { zone: 'UTC' });
  return parsed.isValid ? parsed.weekday : 0;
}

/** ISO week label, e.g. `2026-W48`. */
export function isoWeek(date: string): string {
  const parsed = DateTime.fromISO(date, { zone: 'UTC' });
  return parsed.isValid ? `${parsed.weekYear}-W${String(parsed.weekNumber).padStart(2, '0')}` : '';
}

/**
 * The `count` dates that end at `end`, inclusive, oldest first: `dateWindow('2026-11-10', 3)` is
 * 08, 09, 10.
 */
export function dateWindow(end: string, count: number): string[] {
  const out: string[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    out.push(shiftDate(end, -back));
  }
  return out;
}

/** The `count` dates strictly before `date`, oldest first. A norm window never includes its own day. */
export function windowBefore(date: string, count: number): string[] {
  return dateWindow(shiftDate(date, -1), count);
}

export type DayField = { [K in keyof DayHealth]: DayHealth[K] extends number | null ? K : never }[keyof DayHealth];

/** One numeric field of a day, or null when the day or the field is missing. */
export function valueOn(history: HealthHistory, date: string, field: DayField): number | null {
  const value = history.days[date]?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The non-null values of `field` over `dates`. */
export function valuesOver(history: HealthHistory, dates: readonly string[], field: DayField): number[] {
  return dates
    .map((date) => valueOn(history, date, field))
    .filter((value): value is number => value !== null);
}

/** The median of `field` over `dates`, or null with fewer than `minValues` values (no weak norm). */
export function normOver(
  history: HealthHistory,
  dates: readonly string[],
  field: DayField,
  minValues: number,
): number | null {
  const values = valuesOver(history, dates, field);
  return values.length < minValues ? null : median(values);
}

/** Relative deviation `|value - norm| / norm`; 0 when the norm is not positive. */
export function relativeDeviation(value: number, norm: number): number {
  return norm > 0 ? Math.abs(value - norm) / norm : 0;
}

/**
 * Threshold comparisons that survive floating point: `1.5 * 0.1` is `0.15000000000000002`, so a
 * plain `0.15 >= 1.5 * 0.1` would miss a value sitting exactly on the threshold.
 */
const EPSILON = 1e-9;

export function atLeast(value: number, threshold: number): boolean {
  return value >= threshold - EPSILON;
}

export function atMost(value: number, threshold: number): boolean {
  return value <= threshold + EPSILON;
}
