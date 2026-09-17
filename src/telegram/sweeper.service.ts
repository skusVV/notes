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
   * One tick. Delivers every reminder due before the next tick would run, so a notification lands
   * up to one interval early and never late.
   *
   * Each reminder is **claimed then sent**: the `scheduled -> sent` flip happens in a transaction,
   * and only the transaction's winner composes a delivery. Two overlapping ticks therefore cannot
   * both notify. A send that fails is logged and left `sent` - for v1, losing one notification is
   * preferable to the double-send a retry without a lease would risk.
   *
   * Returns the number of deliveries sent. Never throws: one bad reminder must not abort the rest.
   */
  async sweep(now: Date, sink?: string[]): Promise<number> {
    if (!this.reminders.available) {
      this.logger.warn('Sweep skipped: the reminder store is unavailable');
      return 0;
    }

    const cutoff = this.cutoff(now);
    const due = await this.reminders.findDue(cutoff);
    this.logger.log(
      `Sweep found ${due.length} due reminder(s) up to ${cutoff.toISOString()} (${this.intervalMinutes}m look-ahead)`,
    );

    let sent = 0;
    for (const reminder of due) {
      try {
        const claimed = await this.reminders.claimForSend(reminder.ref, now);
        if (!claimed) {
          // Another tick won the race, or a button already moved it. Not an error.
          this.logger.log(`Skipped reminder ${reminder.id}: no longer scheduled`);
          continue;
        }

        await this.telegram.sendReminder(reminder, sink);
        sent += 1;
      } catch (error) {
        // Ids and counts only - the reminder's text is the user's private note.
        this.logger.error(`Failed to deliver reminder ${reminder.id}`, error as Error);
      }
    }

    this.logger.log(`Sweep delivered ${sent} of ${due.length} due reminder(s)`);
    return sent;
  }
}
