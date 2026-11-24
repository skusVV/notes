import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import {
  DIGEST_SECTIONS,
  DigestContext,
  DigestSection,
  DigestSectionResult,
} from '../digest/digest.types';
import { GarminDigestReader, GarminMorning } from './garmin-digest.reader';
import { formatDuration, formatNumber, hrvRangeBar, sleepQualifierLabel } from './garmin-format';

/**
 * The digest's "😴 Сон і відновлення" section (spec 0018): last night's sleep, HRV against Garmin's
 * baseline, and resting heart rate, all from `health_daily/{today}` - Garmin files sleep under the
 * wake-up date. Body battery is deliberately left out (owner decision).
 *
 * Silent when the user has no Garmin, and when today's sync is not fresh: then
 * `GarminYesterdaySection` shows the single "⌚ Garmin" card for both.
 */
@Injectable()
export class GarminRecoverySection implements DigestSection, OnModuleInit {
  readonly id = 'garmin-recovery';
  readonly order = 11;

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
    if ((await this.reader.isFresh(ctx.userId, ctx)) !== true) {
      return null;
    }
    return recoveryResult(await this.reader.readMorning(ctx.userId, ctx));
  }
}

/** The section from what was read, or null when it would have no lines. Pure. */
export function recoveryResult(data: GarminMorning | null): DigestSectionResult | null {
  if (!data) {
    return null;
  }

  const lines: string[] = [];

  if (data.sleepSeconds !== null) {
    let sleep = `Сон: ${formatDuration(data.sleepSeconds)}`;
    if (data.sleepScore !== null) {
      sleep += `, оцінка ${formatNumber(data.sleepScore)}`;
      const qualifier = sleepQualifierLabel(data.sleepScoreQualifier);
      if (qualifier !== null) {
        sleep += ` (${qualifier})`;
      }
    }
    lines.push(sleep);
  }

  if (data.hrvLastNightAvg !== null) {
    const value = `HRV: ${formatNumber(data.hrvLastNightAvg)} мс`;
    const range = hrvRangeBar(
      data.hrvLastNightAvg,
      data.hrvBaselineBalancedLow,
      data.hrvBaselineBalancedUpper,
    );
    lines.push(range === null ? value : `${value}, ${range}`);
  }

  if (data.restingHr !== null) {
    // The number alone: Garmin gives no baseline for it, and we do not invent one.
    lines.push(`Пульс спокою: ${formatNumber(data.restingHr)}`);
  }

  if (lines.length === 0) {
    return null;
  }
  return { title: '😴 Сон і відновлення', lines };
}
