import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DateTime } from 'luxon';
import {
  DIGEST_SECTIONS,
  DigestContext,
  DigestSection,
  DigestSectionResult,
} from '../digest/digest.types';
import { humanizeTimeOfDay } from './humanize-time';
import { DayReminder, RemindersService } from './reminders.service';

/**
 * Reminder statuses the digest still shows. `sent` stays in: a reminder already delivered this
 * morning but not marked done is still part of today's plan. Anything else (`acked`, `cancelled`)
 * is left out.
 */
const SHOWN_STATUSES: ReadonlySet<string> = new Set(['scheduled', 'sent']);

/**
 * The digest's "Нагадування" section: reminders whose **event** falls on today's local day.
 *
 * One line per reminder, not per notification - an appointment with an evening-before and a
 * morning-of nudge is one line - and the time shown is the event's (`eventAt`), not a nudge's.
 * The section deliberately duplicates the reminder's own delivery: the digest is the plan for the
 * day, the reminder is the signal at its time, and the user gets both.
 */
@Injectable()
export class RemindersDigestSection implements DigestSection, OnModuleInit {
  readonly id = 'reminders';
  readonly order = 100;

  constructor(
    private readonly reminders: RemindersService,
    @Inject(DIGEST_SECTIONS) private readonly sections: DigestSection[],
  ) {}

  /** The one registration line: adds this section to the digest's list. */
  onModuleInit(): void {
    if (!this.sections.includes(this)) {
      this.sections.push(this);
    }
  }

  async build(ctx: DigestContext): Promise<DigestSectionResult | null> {
    const found = await this.reminders.listForDay(ctx.userId, ctx.dayStart, ctx.dayEnd);
    const today = found
      .filter((reminder) => SHOWN_STATUSES.has(reminder.status))
      .sort((a, b) => a.eventAtUtc.getTime() - b.eventAtUtc.getTime());

    if (today.length === 0) {
      return null;
    }

    return {
      title: 'Нагадування',
      lines: today.map((reminder) => line(reminder, ctx.timezone)),
    };
  }
}

/**
 * 'Прийняти таблетки - о 14:00', or just the title for an all-day event. The time is the event's
 * wall clock in its own stored offset, rendered through humanizeTimeOfDay - never a raw ISO string.
 */
function line(reminder: DayReminder, timezone: string): string {
  if (reminder.allDay) {
    return reminder.title;
  }

  const own = DateTime.fromISO(reminder.eventAt, { setZone: true });
  const at = own.isValid ? own : DateTime.fromJSDate(reminder.eventAtUtc).setZone(timezone);
  if (!at.isValid) {
    return reminder.title;
  }

  return `${reminder.title} - ${humanizeTimeOfDay(at.toFormat('HH:mm'))}`;
}
