import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RemindersService } from '../reminders/reminders.service';
import { TelegramService } from './telegram.service';

/**
 * Cron interval used when REMINDER_SWEEP_INTERVAL_MINUTES is unset or unusable. It must match the
 * Cloud Scheduler frequency: a cron slower than this look-ahead delivers reminders late, a faster
 * one re-sweeps the same window (harmless, but wasteful).
 */
export const DEFAULT_SWEEP_INTERVAL_MINUTES = 30;

/**
 * The delivery half of reminders: find what is due and send it.
 *
 * Lives in the telegram module rather than the reminders module because it needs both the store and
 * the bot, and telegram already imports reminders - putting it the other way round would make the
 * two modules import each other.
 */
@Injectable()
export class SweeperService {
  private readonly logger = new Logger(SweeperService.name);

  /** How far ahead of "now" a tick reaches. See {@link DEFAULT_SWEEP_INTERVAL_MINUTES}. */
  readonly intervalMinutes: number;

  constructor(
    private readonly config: ConfigService,
    private readonly reminders: RemindersService,
    private readonly telegram: TelegramService,
  ) {
    this.intervalMinutes = this.parseIntervalMinutes();

    if (!this.secret) {
      this.logger.warn(
        'REMINDER_SWEEP_SECRET is not set - POST /sweep is disabled and no reminder will be delivered',
      );
    }
  }

  /**
   * The shared secret Cloud Scheduler must present. Undefined disables the endpoint outright: an
   * unauthenticated sweep endpoint would let anyone on the internet trigger deliveries, so "no
   * secret configured" fails closed rather than open.
   */
  get secret(): string | undefined {
    // Secret Manager values often carry a trailing newline, and the header cannot contain
    // whitespace, so trimming can only help.
    return this.config.get<string>('REMINDER_SWEEP_SECRET')?.trim() || undefined;
  }

  private parseIntervalMinutes(): number {
    const raw = this.config.get<string>('REMINDER_SWEEP_INTERVAL_MINUTES')?.trim();
    if (!raw) {
      return DEFAULT_SWEEP_INTERVAL_MINUTES;
    }

    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      this.logger.warn(
        `Ignoring invalid REMINDER_SWEEP_INTERVAL_MINUTES "${raw}", using ${DEFAULT_SWEEP_INTERVAL_MINUTES}`,
      );
      return DEFAULT_SWEEP_INTERVAL_MINUTES;
    }

    return value;
  }

  /** The look-ahead horizon for a tick starting at `now`. */
  cutoff(now: Date): Date {
    return new Date(now.getTime() + this.intervalMinutes * 60_000);
  }

  /**
   * One tick. Delivers every notification due before the next tick would run, so a nudge lands up
   * to one interval early and never late.
   *
   * Each notification is **claimed then sent**: the `scheduled -> sent` flip happens in a
   * transaction, and only the transaction's winner composes a delivery. Two overlapping ticks
   * therefore cannot both notify. A send that fails is logged and left `sent` - for v1, losing one
   * notification is preferable to the double-send a retry without a lease would risk.
   *
   * The unit of work is the notification, not the reminder: one appointment with an evening-before
   * and a morning-of nudge is delivered by two separate ticks, each claiming its own document.
   *
   * A recurring reminder rides the same machinery and adds one step: once its single occurrence has
   * been claimed, the tick arms the following one. That is the whole of recurrence at delivery time.
   *
   * Returns the number of deliveries sent. Never throws: one bad document must not abort the rest.
   */
  async sweep(now: Date, sink?: string[]): Promise<number> {
    if (!this.reminders.available) {
      this.logger.warn('Sweep skipped: the reminder store is unavailable');
      return 0;
    }

    const cutoff = this.cutoff(now);

    // Reminders written before notifications existed still carry the scalar `remindAt`. Converting
    // them here - never fatally: a backfill that fails must not stop today's deliveries.
    try {
      await this.reminders.backfillLegacy(cutoff);
    } catch (error) {
      this.logger.error('Legacy reminder backfill failed', error as Error);
    }

    const due = await this.reminders.findDue(cutoff);
    this.logger.log(
      `Sweep found ${due.length} due notification(s) up to ${cutoff.toISOString()} (${this.intervalMinutes}m look-ahead)`,
    );

    let sent = 0;
    for (const notification of due) {
      let claimed = false;
      try {
        claimed = await this.reminders.claimForSend(notification.ref, now);
        if (!claimed) {
          // Another tick won the race, or a button already moved it. Not an error.
          this.logger.log(`Skipped notification ${notification.id}: no longer scheduled`);
          continue;
        }

        await this.telegram.sendReminder(notification, now, sink);
        sent += 1;
      } catch (error) {
        // Ids and counts only - the reminder's text is the user's private note.
        this.logger.error(`Failed to deliver notification ${notification.id}`, error as Error);
      }

      // Roll a recurring reminder forward. Deliberately keyed on the CLAIM, not on the send: the
      // claim already flipped this occurrence to `sent`, so skipping the roll-forward after a failed
      // send would leave the reminder with no scheduled occurrence at all - it would stop recurring
      // silently, which is worse than the one missed nudge. The store's own guard keeps this
      // idempotent, so a retried tick cannot arm two.
      if (claimed && notification.recurrence) {
        try {
          const next = await this.reminders.enqueueNextOccurrence(notification, now);
          if (next) {
            this.logger.log(`Next occurrence of reminder ${notification.reminderId} is at ${next}`);
          }
        } catch (error) {
          this.logger.error(
            `Failed to arm the next occurrence of reminder ${notification.reminderId}`,
            error as Error,
          );
        }
      }
    }

    this.logger.log(`Sweep delivered ${sent} of ${due.length} due notification(s)`);
    return sent;
  }
}
