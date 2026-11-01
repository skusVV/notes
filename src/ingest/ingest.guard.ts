import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

/**
 * The shared check for every `/ingest/*` endpoint: the owner's own devices (an iPhone Shortcut
 * today, calendar and health sync later) posting into the bot. Authenticated with its own secret
 * rather than the Telegram webhook's, because it is a different caller.
 *
 * Unlike the webhook, "not configured" fails closed: with no `INGEST_SECRET` or no valid
 * `INGEST_USER_ID` the endpoint answers 401, the same as `/sweep` without its secret. An open
 * ingest endpoint would let anyone on the internet write into the owner's memory.
 */
@Injectable()
export class IngestGuard {
  private readonly logger = new Logger(IngestGuard.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Throws 401 unless `received` matches `INGEST_SECRET` (constant-time compare) and
   * `INGEST_USER_ID` is configured. Returns the owner's Telegram user id - taken from config, never
   * from the request, so a caller cannot claim to be someone else.
   */
  assertIngestSecret(received: string | undefined): number {
    // Secret Manager values often carry a trailing newline, so the configured value is trimmed.
    const expected = this.config.get<string>('INGEST_SECRET')?.trim();
    if (!expected) {
      this.logger.warn('Rejected ingest: INGEST_SECRET is not set, the endpoint is disabled');
      throw new UnauthorizedException();
    }

    const userId = this.ownerId();
    if (userId === undefined) {
      this.logger.warn('Rejected ingest: INGEST_USER_ID is not set, the endpoint is disabled');
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

  /** `INGEST_USER_ID` as a positive integer, or undefined when unset or not a valid id. */
  private ownerId(): number | undefined {
    const raw = this.config.get<string>('INGEST_USER_ID')?.trim();
    if (!raw) {
      return undefined;
    }

    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      this.logger.warn(`Ignoring invalid INGEST_USER_ID "${raw}"`);
      return undefined;
    }

    return id;
  }
}
