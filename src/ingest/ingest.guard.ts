import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { TelegramService } from '../telegram/telegram.service';

/**
 * The shared check for every `/ingest/*` endpoint: the owner's own devices (an iPhone Shortcut
 * today, calendar and health sync later) posting into the bot. Authenticated with its own secret
 * rather than the Telegram webhook's, because it is a different caller.
 *
 * Unlike the webhook, "not configured" fails closed: with no `INGEST_SECRET`, or no valid id in
 * `ALLOWED_USERS` to act as the owner, the endpoint answers 401, the same as `/sweep` without its
 * secret. An open ingest endpoint would let anyone on the internet write into the owner's memory.
 */
@Injectable()
export class IngestGuard {
  private readonly logger = new Logger(IngestGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly telegram: TelegramService,
  ) {}

  /**
   * Throws 401 unless `received` matches `INGEST_SECRET` (constant-time compare) and an owner is
   * configured. Returns the owner's Telegram user id - the first id in `ALLOWED_USERS`, taken from
   * config and never from the request, so a caller cannot claim to be someone else.
   */
  assertIngestSecret(received: string | undefined): number {
    // Secret Manager values often carry a trailing newline, so the configured value is trimmed.
    const expected = this.config.get<string>('INGEST_SECRET')?.trim();
    if (!expected) {
      this.logger.warn('Rejected ingest: INGEST_SECRET is not set, the endpoint is disabled');
      throw new UnauthorizedException();
    }

    const userId = this.telegram.ownerUserId();
    if (userId === undefined) {
      this.logger.warn(
        'Rejected ingest: ALLOWED_USERS has no valid id to act as owner, the endpoint is disabled',
      );
      throw new UnauthorizedException();
    }

    const a = Buffer.from(received?.trim() ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      // Lengths only, never either secret - same as the webhook and sweep checks.
      this.logger.warn(
        `Rejected ingest: secret mismatch (received ${a.length} chars, expected ${b.length})`,
      );
      throw new UnauthorizedException();
    }

    return userId;
  }
}
