import { Inject, Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { MONTHS_GENITIVE } from '../reminders/humanize-time';
import {
  DIGEST_SECTIONS,
  DigestContext,
  DigestSection,
  DigestSectionResult,
} from './digest.types';

/**
 * The most lines one section may show. Past it the section ends in '• …і ще N', so one giant
 * section (an 80-item to-do some day) cannot crowd out the rest, and Telegram's 4096-character
 * chunking does not cut the message in the middle of a section.
 */
export const DIGEST_MAX_LINES_PER_SECTION = 15;

/** The marker every line gets. Sections hand over bare lines. */
const BULLET = '• ';

/**
 * Assembles the morning digest from whatever sections are registered. It knows only the
 * `DigestSection` interface: a new section never needs a change here.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(@Inject(DIGEST_SECTIONS) private readonly sections: DigestSection[]) {}

  /**
   * The digest text for `ctx`, or `undefined` when every section is empty - an empty day sends
   * nothing at all.
   *
   * Sections are asked in parallel, each in its own try/catch: one that throws is logged by id and
   * skipped, and the rest still make the message. Plain text - the caller sends it with no
   * `parse_mode`, because section lines carry the user's own words.
   */
  async build(ctx: DigestContext): Promise<string | undefined> {
    const results = await Promise.all(
      this.sections.map(async (section) => {
        try {
          const result = await section.build(ctx);
          return { section, result };
        } catch (error) {
          // The section id and the user id only - never what the section was about to show.
          this.logger.error(
            `Digest section ${section.id} failed for user ${ctx.userId}`,
            error as Error,
          );
          return { section, result: null };
        }
      }),
    );

    const shown = results
      .filter(
        (entry): entry is { section: DigestSection; result: DigestSectionResult } =>
          entry.result !== null && Array.isArray(entry.result.lines) && entry.result.lines.length > 0,
      )
      .sort((a, b) => a.section.order - b.section.order);

    if (shown.length === 0) {
      return undefined;
    }

    // Counts only: the lines themselves are the user's private notes.
    this.logger.log(
      `Digest for user ${ctx.userId}: ${shown
        .map(({ section, result }) => `${section.id}=${result.lines.length}`)
        .join(', ')}`,
    );

    const blocks = shown.map(({ result }) => renderSection(result));
    return [greeting(ctx), ...blocks].join('\n\n');
  }
}

/** 'Доброго ранку! Сьогодні 16 вересня.' - the date read in the digest's own zone, never raw ISO. */
function greeting(ctx: DigestContext): string {
  const zoned = DateTime.fromJSDate(ctx.dayStart).setZone(ctx.timezone);
  const day = zoned.isValid ? zoned : DateTime.fromJSDate(ctx.dayStart).setZone('UTC');
  return `Доброго ранку! Сьогодні ${day.day} ${MONTHS_GENITIVE[day.month - 1]}.`;
}

/** A heading, then one bulleted line each, capped at {@link DIGEST_MAX_LINES_PER_SECTION}. */
function renderSection(result: DigestSectionResult): string {
  const kept = result.lines.slice(0, DIGEST_MAX_LINES_PER_SECTION);
  const dropped = result.lines.length - kept.length;
  const lines = kept.map((line) => `${BULLET}${line}`);
  if (dropped > 0) {
    lines.push(`${BULLET}…і ще ${dropped}`);
  }
  return [result.title, ...lines].join('\n');
}
