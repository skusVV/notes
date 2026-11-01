import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { TelegramService } from '../telegram/telegram.service';

/**
 * The shared check for every `/ingest/*` endpoint: allowed users' own devices (an iPhone Shortcut
 * today, calendar and health sync later) posting into the bot. Authenticated with its own secret
 * rather than the Telegram webhook's, because it is a different caller.
 *
 * Unlike the webhook, "not configured" fails closed: with no `INGEST_SECRET`, or no valid id in
 * `ALLOWED_USERS`, the endpoint answers 401, the same as `/sweep` without its secret. An open
 * allowlist would let anyone holding the secret write as any user id at all.
 *
 * This only authenticates the caller. Which user the request acts for is the body's `userId`,
 * validated and checked against `ALLOWED_USERS` by each endpoint after this guard.
 */
@Injectable()
export class IngestGuard {
  private readonly logger = new Logger(IngestGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly telegram: TelegramService,
  ) {}

  /**
   * Throws 401 unless `received` matches `INGEST_SECRET` (constant-time compare) and
   * `ALLOWED_USERS` has at least one valid id.
   */
  assertIngestSecret(received: string | undefined): void {
    // Secret Manager values often carry a trailing newline, so the configured value is trimmed.
    const expected = this.config.get<string>('INGEST_SECRET')?.trim();
    if (!expected) {
      this.logger.warn('Rejected ingest: INGEST_SECRET is not set, the endpoint is disabled');
      throw new UnauthorizedException();
    }

    if (!this.telegram.hasAllowlist()) {
      this.logger.warn('Rejected ingest: ALLOWED_USERS has no valid id, the endpoint is disabled');
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
  }
}
