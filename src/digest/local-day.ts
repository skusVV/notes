import { DateTime } from 'luxon';

/** The local calendar day an instant falls in, as the digest sees it. */
export interface LocalDay {
  /** 'YYYY-MM-DD' in the local zone - the key `users/{id}.digest.lastSentOn` is compared against. */
  dateKey: string;
  /** Local midnight that starts the day, inclusive. */
  dayStart: Date;
  /** The next local midnight, exclusive. */
  dayEnd: Date;
}

/**
 * The local day `now` falls in, in `timezone`: `[00:00, next 00:00)` wall-clock. Pure - no Nest, no
 * clock - so a pinned `now` pins the whole result.
 *
 * The end is the next calendar day's start, never `start + 24h`: on a DST change the day is 23 or 25
 * hours long, and a fixed 24 hours would either leak into tomorrow or lose the last hour of today.
 * An unknown zone degrades to UTC rather than throwing, the same rule as `ClockService.formatLocal`.
 */
export function localDay(now: Date, timezone: string): LocalDay {
  const zoned = DateTime.fromJSDate(now).setZone(timezone);
  const local = zoned.isValid ? zoned : DateTime.fromJSDate(now).setZone('UTC');

  const start = local.startOf('day');
  const end = start.plus({ days: 1 }).startOf('day');

  return {
    dateKey: start.toISODate() ?? '',
    dayStart: start.toJSDate(),
    dayEnd: end.toJSDate(),
  };
}
