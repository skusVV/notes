import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  DIGEST_SECTIONS,
  DigestContext,
  DigestSection,
  DigestSectionResult,
} from '../digest/digest.types';
import { InsightPhrasingService } from '../insights/insight-phrasing.service';
import { InsightJournal } from '../insights/insights.types';
import { nextJournal, planInsights } from '../insights/rank';
import { GarminDigestReader } from './garmin-digest.reader';
import { GarminHistoryReader } from './garmin-history.reader';
import { garminRawKeyboard } from './garmin-raw';

export const GARMIN_INSIGHTS_TITLE = "⌚ Здоров'я";
/** The whole section when Garmin is set up but today's sync has not succeeded. */
export const GARMIN_INSIGHTS_STALE_LINE = 'сьогодні даних немає';

/**
 * The digest's "⌚ Здоров'я" section (spec 0026): a readiness line and up to three ranked insights
 * computed from the morning job's Garmin data, instead of 0018's raw numbers - those sit behind the
 * `📊 Дані Garmin` button under the digest.
 *
 * Freshness as in 0018: no `system/garminSync` is no section; a sync that did not succeed today is
 * one `сьогодні даних немає` line without the button (content for the 0024 empty-day rule). The
 * journal is written while building, because the runner never sends the same day twice.
 *
 * Never logs a value or a line: user id, section id, line count, insight keys and `fallback=<n>`.
 */
@Injectable()
export class GarminInsightsSection implements DigestSection, OnModuleInit {
  private readonly logger = new Logger(GarminInsightsSection.name);
  readonly id = 'garmin-insights';
  readonly order = 10;

  constructor(
    private readonly reader: GarminDigestReader,
    private readonly history: GarminHistoryReader,
    private readonly phrasing: InsightPhrasingService,
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
      return null;
    }
    if (!fresh) {
      this.logger.log(`Garmin data for user ${ctx.userId} is not fresh today`);
      return { title: GARMIN_INSIGHTS_TITLE, lines: [GARMIN_INSIGHTS_STALE_LINE] };
    }

    const [history, journal] = await Promise.all([
      this.history.read(ctx.userId, ctx),
      this.readJournal(ctx.userId),
    ]);
    const plan = planInsights(history, journal);
    if (plan.lines.length === 0) {
      return null;
    }

    const phrased = await this.phrasing.phrase(plan.lines);
    const lines = plan.lines.map((line, index) => {
      const text = phrased.texts[index] ?? line.template;
      return line.marker ? `${line.marker} ${text}` : text;
    });

    if (plan.shownKeys.length > 0) {
      try {
        await this.history.writeJournal(ctx.userId, nextJournal(journal, plan.shownKeys, history.today));
      } catch (error) {
        this.logger.error(
          `Failed to write the insight journal for user ${ctx.userId}: ${(error as Error)?.name ?? 'error'}`,
        );
      }
    }

    this.logger.log(
      `Section ${this.id} for user ${ctx.userId}: ${lines.length} lines, ` +
        `keys [${plan.shownKeys.join(', ')}], fallback=${phrased.fallback}`,
    );
    return { title: GARMIN_INSIGHTS_TITLE, lines, keyboard: garminRawKeyboard() };
  }

  /** A failed read is an empty journal, never a failed section. */
  private async readJournal(userId: number): Promise<InsightJournal> {
    try {
      return await this.history.readJournal(userId);
    } catch {
      return { shown: {} };
    }
  }
}
