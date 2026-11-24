import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { DigestContext } from '../digest/digest.types';
import { FirestoreService } from '../firestore/firestore.service';

/**
 * What the "Вчора" section needs from `health_daily/{yesterday}`. Only the fields it shows; every
 * one is null when Garmin had no value, never 0.
 */
export interface GarminYesterdayDay {
  steps: number | null;
  stepsGoal: number | null;
  floorsUp: number | null;
}

/** One activity of yesterday, as stored by the morning job in `activities/{activityId}`. */
export interface GarminActivity {
  /** Garmin's `activityType.typeKey`, stored as `type`. */
  type: string | null;
  /** Wall-clock start, `YYYY-MM-DD HH:mm:ss`. Used for the day filter and ordering only. */
  startTimeLocal: string;
  durationSec: number | null;
}

export interface GarminYesterday {
  /** The local date read, `YYYY-MM-DD`. */
  date: string;
  /** null when `health_daily/{date}` does not exist - unknown, not "nothing happened". */
  day: GarminYesterdayDay | null;
  /** Yesterday's activities by start time, earliest first. */
  activities: GarminActivity[];
}

/** What the "Сон і відновлення" section needs from `health_daily/{today}`. */
export interface GarminMorning {
  sleepSeconds: number | null;
  sleepScore: number | null;
  sleepScoreQualifier: string | null;
  hrvLastNightAvg: number | null;
  hrvBaselineBalancedLow: number | null;
  hrvBaselineBalancedUpper: number | null;
  restingHr: number | null;
}

/** The two dates the Garmin sections read, both local to the digest's zone. */
export interface GarminDates {
  today: string;
  yesterday: string;
}

/**
 * The two local dates for a digest: today is the local date of `dayStart`, yesterday is that date
 * minus one **calendar** day (luxon `minus({ days: 1 })`), never minus 24 hours - on the morning
 * after a DST change those disagree. An unknown zone degrades to UTC, as `localDay` does.
 */
export function garminDates(ctx: Pick<DigestContext, 'dayStart' | 'timezone'>): GarminDates {
  const zoned = DateTime.fromJSDate(ctx.dayStart).setZone(ctx.timezone);
  const local = (zoned.isValid ? zoned : DateTime.fromJSDate(ctx.dayStart).setZone('UTC')).startOf(
    'day',
  );
  return {
    today: local.toISODate() ?? '',
    yesterday: local.minus({ days: 1 }).toISODate() ?? '',
  };
}

/**
 * Reads the Garmin data the morning job (0010 / 0022) wrote under `users/{id}`. Read-only: nothing
 * here writes `health_daily`, `activities` or `system/garminSync`.
 *
 * Every read degrades with the Firestore provider: with no store there is "no Garmin" (`isFresh`
 * answers undefined), so the sections stay silent. Never logs a value - the sections and the digest
 * log ids and line counts only.
 */
@Injectable()
export class GarminDigestReader {
  /**
   * One freshness read per digest: both sections ask, and they must agree on whether to show data or
   * the "no data today" card. Keyed by the context object `DigestService` hands every section, so it
   * is dropped with the digest.
   */
  private readonly freshness = new WeakMap<DigestContext, Promise<boolean | undefined>>();

  constructor(private readonly firestore: FirestoreService) {}

  /**
   * Whether this user's Garmin sync succeeded today: `undefined` when `system/garminSync` does not
   * exist (no Garmin set up), otherwise whether `lastSuccessAt` falls on today's local date. A doc
   * with no usable `lastSuccessAt` (only failed runs) is not fresh.
   */
  isFresh(userId: number, ctx: DigestContext): Promise<boolean | undefined> {
    const cached = this.freshness.get(ctx);
    if (cached) {
      return cached;
    }

    const read = this.readFreshness(userId, ctx);
    this.freshness.set(ctx, read);
    // A failed read is not cached, so the other section gets its own try (and its own logged error).
    read.catch(() => this.freshness.delete(ctx));
    return read;
  }

  /** `health_daily/{yesterday}` and yesterday's activities. */
  async readYesterday(userId: number, ctx: DigestContext): Promise<GarminYesterday> {
    const { today, yesterday } = garminDates(ctx);
    const db = this.firestore.db;
    if (!db) {
      return { date: yesterday, day: null, activities: [] };
    }

    const user = db.collection('users').doc(String(userId));
    // A range on the one field `startTimeLocal` ('YYYY-MM-DD HH:mm:ss', so string order is time
    // order): single-field auto-index, no composite index. Sorted here rather than with orderBy.
    const [daySnapshot, activitySnapshot] = await Promise.all([
      user.collection('health_daily').doc(yesterday).get(),
      user
        .collection('activities')
        .where('startTimeLocal', '>=', yesterday)
        .where('startTimeLocal', '<', today)
        .get(),
    ]);

    const data = daySnapshot.exists ? daySnapshot.data() : undefined;
    const movement = record(data?.movement);
    const day: GarminYesterdayDay | null = data
      ? {
          steps: num(movement.steps),
          stepsGoal: num(movement.stepsGoal),
          floorsUp: num(movement.floorsUp),
        }
      : null;

    const activities = activitySnapshot.docs
      .map((doc) => readActivity(doc.data(), yesterday))
      .filter((activity): activity is GarminActivity => activity !== null)
      .sort((a, b) => (a.startTimeLocal < b.startTimeLocal ? -1 : a.startTimeLocal > b.startTimeLocal ? 1 : 0));

    return { date: yesterday, day, activities };
  }

  /** `health_daily/{today}`: last night's sleep (Garmin files it under the wake-up date), HRV, resting HR. */
  async readMorning(userId: number, ctx: DigestContext): Promise<GarminMorning | null> {
    const { today } = garminDates(ctx);
    const db = this.firestore.db;
    if (!db) {
      return null;
    }

    const snapshot = await db
      .collection('users')
      .doc(String(userId))
      .collection('health_daily')
      .doc(today)
      .get();
    const data = snapshot.exists ? snapshot.data() : undefined;
    if (!data) {
      return null;
    }

    const sleep = record(data.sleep);
    const hrv = record(data.hrv);
    const heart = record(data.heart);
    return {
      sleepSeconds: num(sleep.seconds),
      sleepScore: num(sleep.score),
      sleepScoreQualifier: typeof sleep.scoreQualifier === 'string' ? sleep.scoreQualifier : null,
      hrvLastNightAvg: num(hrv.lastNightAvg),
      hrvBaselineBalancedLow: num(hrv.baselineBalancedLow),
      hrvBaselineBalancedUpper: num(hrv.baselineBalancedUpper),
      restingHr: num(heart.resting),
    };
  }

  private async readFreshness(userId: number, ctx: DigestContext): Promise<boolean | undefined> {
    const db = this.firestore.db;
    if (!db) {
      return undefined;
    }

    const snapshot = await db
      .collection('users')
      .doc(String(userId))
      .collection('system')
      .doc('garminSync')
      .get();
    const data = snapshot.exists ? snapshot.data() : undefined;
    if (!data) {
      return undefined;
    }

    const at = instant(data.lastSuccessAt);
    if (!at) {
      return false;
    }
    const zoned = at.setZone(ctx.timezone);
    const local = zoned.isValid ? zoned : at.setZone('UTC');
    return local.toISODate() === garminDates(ctx).today;
  }
}

/**
 * `lastSuccessAt` as an instant. The morning job writes an ISO string with an offset (`toISOString`);
 * a Firestore Timestamp is accepted too. Anything else - or a string with no offset, which pins no
 * moment - is unusable.
 */
function instant(value: unknown): DateTime | null {
  if (typeof value === 'string') {
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) {
      return null;
    }
    const parsed = DateTime.fromISO(value.trim());
    return parsed.isValid ? parsed : null;
  }
  const toDate = (value as { toDate?: unknown } | null | undefined)?.toDate;
  if (typeof toDate === 'function') {
    const date = toDate.call(value) as unknown;
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      return DateTime.fromJSDate(date);
    }
  }
  return null;
}

/** An activity doc read defensively; one whose start is not on `date` is dropped. */
function readActivity(data: unknown, date: string): GarminActivity | null {
  const doc = record(data);
  const start = doc.startTimeLocal;
  if (typeof start !== 'string' || start.slice(0, 10) !== date) {
    return null;
  }
  return {
    type: typeof doc.type === 'string' ? doc.type : null,
    startTimeLocal: start,
    durationSec: num(doc.durationSec),
  };
}

/** A finite number or null - absent stays absent, never 0. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
