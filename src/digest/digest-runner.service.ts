import { Injectable, Logger } from '@nestjs/common';
import { ClassifierService } from '../classifier/classifier.service';
import { TelegramService } from '../telegram/telegram.service';
import { DigestSettingsService } from './digest-settings.service';
import { DigestService } from './digest.service';
import { localDay } from './local-day';

/** Why a digest was not sent. Reported in the `/ingest/digest` response body. */
export type DigestSkipReason = 'disabled' | 'already_sent' | 'empty' | 'send_failed';

export interface DigestRunResult {
  sent: boolean;
  reason?: DigestSkipReason;
}

/**
 * Everything `POST /ingest/digest` does once the request is validated: decide whether this user gets
 * a digest today, claim the day, and send it. The controller has already run the secret check and
 * the `ALLOWED_USERS` gate, so nothing here reads or sends for a user outside the list.
 *
 * Provided by `IngestModule` rather than `DigestModule`: it needs `TelegramService` to send, and
 * `TelegramModule` already imports `DigestModule` for the `/digest` command - registering it the
 * other way round would make the two modules import each other.
 */
@Injectable()
export class DigestRunnerService {
  private readonly logger = new Logger(DigestRunnerService.name);

  constructor(
    private readonly settings: DigestSettingsService,
    private readonly digest: DigestService,
    private readonly telegram: TelegramService,
    // The single parsed DEFAULT_TIMEZONE, the same source the snooze buttons use. No per-user zone
    // exists yet.
    private readonly classifier: ClassifierService,
  ) {}

  /**
   * One run for one user at `now`. Never sends twice for the same local day: the day is claimed in a
   * transaction **before** the send, and a send that fails is logged and not retried.
   */
  async run(userId: number, now: Date, sink?: string[]): Promise<DigestRunResult> {
    const settings = await this.settings.get(userId);
    if (!settings?.enabled) {
      return this.skip(userId, 'disabled');
    }

    const timezone = this.classifier.defaultTimezone;
    const day = localDay(now, timezone);
    if (settings.lastSentOn === day.dateKey) {
      return this.skip(userId, 'already_sent');
    }

    const text = await this.digest.build({
      userId,
      now,
      timezone,
      dayStart: day.dayStart,
      dayEnd: day.dayEnd,
    });
    if (text === undefined) {
      // An empty day sends nothing and does not claim the day.
      return this.skip(userId, 'empty');
    }

    if (!(await this.settings.claimToday(userId, day.dateKey))) {
      // An overlapping call claimed this day between the read above and the transaction.
      return this.skip(userId, 'already_sent');
    }

    try {
      await this.telegram.sendDigest(settings.chatId, text, sink);
    } catch (error) {
      // The id and the error code only - never the digest text. Not retried: the day is already
      // claimed, so a repeat call the same day sends nothing either.
      this.logger.error(`Failed to send the digest to user ${userId}: ${errorCode(error)}`);
      return { sent: false, reason: 'send_failed' };
    }

    this.logger.log(`Sent the digest for ${day.dateKey} to user ${userId}`);
    return { sent: true };
  }

  private skip(userId: number, reason: DigestSkipReason): DigestRunResult {
    this.logger.log(`Digest not sent to user ${userId}: ${reason}`);
    return { sent: false, reason };
  }
}

/**
 * A short code for a failed send: the HTTP status Telegram answered with (403 when the user blocked
 * the bot), else the network error code. Never the error message or request, which carry the text.
 */
function errorCode(error: unknown): string {
  const failure = error as { response?: { status?: unknown }; code?: unknown } | undefined;
  const status = failure?.response?.status;
  if (typeof status === 'number') {
    return `HTTP ${status}`;
  }
  return typeof failure?.code === 'string' ? failure.code : 'unknown error';
}
