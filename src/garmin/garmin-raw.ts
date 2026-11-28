import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { localDay } from '../digest/local-day';
import { MONTHS_GENITIVE } from '../reminders/humanize-time';
import { InlineKeyboardMarkup } from '../telegram/telegram.types';
import { GarminDigestReader, GarminMorning, GarminYesterday } from './garmin-digest.reader';
import {
  formatDuration,
  formatNumber,
  formatSteps,
  hrvRangeBar,
  progressBar,
  sleepQualifierLabel,
} from './garmin-format';

/** `callback_data` of the button under the digest (spec 0026, decision 3). */
export const GARMIN_RAW_CALLBACK = 'gd:raw';
export const GARMIN_RAW_BUTTON = '📊 Дані Garmin';
/** No `system/garminSync`: the user has no Garmin set up. */
export const GARMIN_RAW_NONE = 'Даних Garmin немає.';
/** The sync exists but has not succeeded today. */
export const GARMIN_RAW_STALE = 'Сьогодні даних Garmin ще немає.';

/** The keyboard the insights section puts under the digest. */
export function garminRawKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: GARMIN_RAW_BUTTON, callback_data: GARMIN_RAW_CALLBACK }]] };
}

/**
 * The raw-data message from what was read (decision 11). Pure. Each line only when its value is
 * there; with no line at all it is the "no data yet" text rather than a bare heading. Formatting is
 * 0018's: Garmin's own goal, baseline and qualifier, never a raw key.
 */
export function rawText(date: string, morning: GarminMorning | null, yesterday: GarminYesterday | null): string {
  const lines: string[] = [];

  if (morning?.sleepSeconds !== null && morning?.sleepSeconds !== undefined) {
    let sleep = `Сон: ${formatDuration(morning.sleepSeconds)}`;
    if (morning.sleepNeedMinutes !== null) {
      sleep += `, потреба ${formatDuration(morning.sleepNeedMinutes * 60)}`;
    }
    if (morning.sleepScore !== null) {
      sleep += `, оцінка ${formatNumber(morning.sleepScore)}`;
      const qualifier = sleepQualifierLabel(morning.sleepScoreQualifier);
      if (qualifier !== null) {
        sleep += ` (${qualifier})`;
      }
    }
    lines.push(sleep);
  }

  if (morning?.hrvLastNightAvg !== null && morning?.hrvLastNightAvg !== undefined) {
    const value = `HRV: ${formatNumber(morning.hrvLastNightAvg)} мс`;
    const range = hrvRangeBar(morning.hrvLastNightAvg, morning.hrvBaselineBalancedLow, morning.hrvBaselineBalancedUpper);
    lines.push(range === null ? value : `${value}, ${range}`);
  }

  if (morning?.restingHr !== null && morning?.restingHr !== undefined) {
    lines.push(`Пульс спокою: ${formatNumber(morning.restingHr)}`);
  }

  const day = yesterday?.day;
  if (day?.steps !== null && day?.steps !== undefined) {
    const bar = progressBar(day.steps, day.stepsGoal);
    lines.push(
      bar === null
        ? `Кроки вчора: ${formatSteps(day.steps)}`
        : `Кроки вчора: ${formatSteps(day.steps)} з ${formatSteps(day.stepsGoal as number)}  ${bar}`,
    );
  }
  if (day?.floorsUp !== null && day?.floorsUp !== undefined) {
    lines.push(`Поверхи вчора: ${formatNumber(day.floorsUp)}`);
  }
  if (day && (day.caloriesTotal !== null || day.caloriesActive !== null)) {
    const parts: string[] = [];
    if (day.caloriesTotal !== null) {
      parts.push(`усього ${formatSteps(day.caloriesTotal)}`);
    }
    if (day.caloriesActive !== null) {
      parts.push(`активні ${formatSteps(day.caloriesActive)}`);
    }
    lines.push(`Калорії вчора: ${parts.join(', ')}`);
  }

  if (lines.length === 0) {
    return GARMIN_RAW_STALE;
  }
  return [`📊 Дані Garmin, ${dateTitle(date)}`, ...lines].join('\n');
}

/** '27 листопада' from 'YYYY-MM-DD' - never the raw ISO date. */
function dateTitle(date: string): string {
  const parsed = DateTime.fromISO(date);
  return parsed.isValid ? `${parsed.day} ${MONTHS_GENITIVE[parsed.month - 1]}` : '';
}

/**
 * Builds the `📊 Дані Garmin` reply from Firestore **at the moment of the tap**, not from the
 * digest, so a later sync shows up. The caller (TelegramService) has already passed the
 * `ALLOWED_USERS` gate. Never logs a value.
 */
@Injectable()
export class GarminRawService {
  constructor(private readonly reader: GarminDigestReader) {}

  async text(userId: number, now: Date, timezone: string): Promise<string> {
    const day = localDay(now, timezone);
    const ctx = { userId, now, timezone, dayStart: day.dayStart, dayEnd: day.dayEnd };

    const fresh = await this.reader.isFresh(userId, ctx);
    if (fresh === undefined) {
      return GARMIN_RAW_NONE;
    }
    if (!fresh) {
      return GARMIN_RAW_STALE;
    }

    const [morning, yesterday] = await Promise.all([
      this.reader.readMorning(userId, ctx),
      this.reader.readYesterday(userId, ctx),
    ]);
    return rawText(day.dateKey, morning, yesterday);
  }
}
