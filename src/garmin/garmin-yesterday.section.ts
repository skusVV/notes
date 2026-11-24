import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DateTime } from 'luxon';
import {
  DIGEST_SECTIONS,
  DigestContext,
  DigestSection,
  DigestSectionResult,
} from '../digest/digest.types';
import { MONTHS_GENITIVE } from '../reminders/humanize-time';
import { GarminActivity, GarminDigestReader, GarminYesterday } from './garmin-digest.reader';
import { activityLabel, formatDuration, formatSteps, progressBar } from './garmin-format';

/**
 * The card both Garmin sections collapse into when the user has Garmin set up
 * (`system/garminSync` exists) but today's sync has not succeeded. Shown by this section only; the
 * recovery section stays silent then, so the user sees it once.
 */
export const GARMIN_STALE_RESULT: Readonly<DigestSectionResult> = Object.freeze({
  title: '⌚ Garmin',
  lines: ['сьогодні даних немає'],
});

/**
 * The digest's "🏃 Вчора, <date>" section (spec 0018): yesterday's steps against Garmin's goal,
 * floors, and workouts, from `health_daily/{yesterday}` and yesterday's `activities`. Numbers only -
 * no praise, no judgement for a rest day.
 */
@Injectable()
export class GarminYesterdaySection implements DigestSection, OnModuleInit {
  private readonly logger = new Logger(GarminYesterdaySection.name);
  readonly id = 'garmin-yesterday';
  readonly order = 10;

  constructor(
    private readonly reader: GarminDigestReader,
    @Inject(DIGEST_SECTIONS) private readonly sections: DigestSection[],
  ) {}

  /** The one registration line: adds this section to the digest's list. */
  onModuleInit(): void {
    if (!this.sections.includes(this)) {
      this.sections.push(this);
    }
  }

  async build(ctx: DigestContext): Promise<DigestSectionResult | null> {
    const fresh = await this.reader.isFresh(ctx.userId, ctx);
    if (fresh === undefined) {
      // No Garmin for this user: nothing at all, not even the "no data" card.
      return null;
    }
    if (!fresh) {
      // The user id and the fact only - never a value.
      this.logger.log(`Garmin data for user ${ctx.userId} is not fresh today`);
      return { title: GARMIN_STALE_RESULT.title, lines: [...GARMIN_STALE_RESULT.lines] };
    }

    return yesterdayResult(await this.reader.readYesterday(ctx.userId, ctx));
  }
}

/** The section from what was read, or null when it would have no lines. Pure. */
export function yesterdayResult(data: GarminYesterday): DigestSectionResult | null {
  const lines: string[] = [];
  const day = data.day;

  if (day?.steps !== null && day?.steps !== undefined) {
    const bar = progressBar(day.steps, day.stepsGoal);
    lines.push(
      bar === null
        ? `Кроки: ${formatSteps(day.steps)}`
        : `Кроки: ${formatSteps(day.steps)} з ${formatSteps(day.stepsGoal as number)}  ${bar}`,
    );
  }

  if (day?.floorsUp !== null && day?.floorsUp !== undefined) {
    lines.push(`Поверхи: ${day.floorsUp}`);
  }

  if (data.activities.length > 0) {
    lines.push(`Тренування: ${data.activities.map(activityText).join(', ')}`);
  } else if (day) {
    // A synced day with no activity is a rest day. With no document at all it is unknown, so no line.
    lines.push('Тренування: вихідний');
  }

  if (lines.length === 0) {
    return null;
  }
  return { title: `🏃 Вчора, ${dateTitle(data.date)}`, lines };
}

/** 'Біг 45 хв', or just the label when Garmin gave no duration. */
function activityText(activity: GarminActivity): string {
  const label = activityLabel(activity.type);
  return activity.durationSec === null ? label : `${label} ${formatDuration(activity.durationSec)}`;
}

/** '1 листопада' from 'YYYY-MM-DD' - never the raw ISO date. */
function dateTitle(date: string): string {
  const parsed = DateTime.fromISO(date);
  return parsed.isValid ? `${parsed.day} ${MONTHS_GENITIVE[parsed.month - 1]}` : '';
}
