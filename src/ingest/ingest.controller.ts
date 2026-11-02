import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClockService } from '../clock/clock.service';
import { DigestRunnerService, DigestSkipReason } from '../digest/digest-runner.service';
import { TelegramService } from '../telegram/telegram.service';
import { IngestGuard } from './ingest.guard';

/** Longest text `/ingest/message` accepts, after trimming. A dictated thought is far shorter. */
export const INGEST_MAX_TEXT_CHARS = 4000;

/** The 400 body for a missing, empty or oversized `text`. */
const INVALID_TEXT = { ok: false, error: 'invalid_text' } as const;

/** The 400 body for a missing `userId`, or one that is not a positive integer. */
const INVALID_USER = { ok: false, error: 'invalid_user' } as const;

/** The 403 body for a `userId` that is not in `ALLOWED_USERS`. */
const USER_NOT_ALLOWED = { ok: false, error: 'user_not_allowed' } as const;

/**
 * The body's `userId` as a positive safe integer, or undefined. A JSON number or a string of digits
 * is accepted, because iOS Shortcuts often send values as text. Zero, negatives, fractions,
 * exponents and anything else non-numeric are rejected - nothing is rounded or guessed.
 */
export function parseIngestUserId(raw: unknown): number | undefined {
  let id: number;
  if (typeof raw === 'number') {
    id = raw;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    id = Number(raw.trim());
  } else {
    return undefined;
  }

  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

@Controller('ingest')
export class IngestController {
  private readonly logger = new Logger(IngestController.name);

  constructor(
    private readonly guard: IngestGuard,
    private readonly telegram: TelegramService,
    private readonly config: ConfigService,
    private readonly digestRunner: DigestRunnerService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Quick capture from an allowed user's phone: the text goes down exactly the path a chat message
   * takes (allowlist, commands, classification, storage, reply in that user's Telegram chat).
   *
   * Checks run in a fixed order: 401 when the secret is wrong or ingest is not configured, then a
   * bad `text` (400 invalid_text), then a bad `userId` (400 invalid_user), then a `userId` outside
   * `ALLOWED_USERS` (403 user_not_allowed). The 400s help the caller's own Shortcut show the error,
   * and there is no Telegram retry loop here. The 403 happens before any model call and sends
   * nothing to Telegram. A failure *after* validation is logged and still answers 200, for the same
   * reason the webhook does.
   */
  @Post('message')
  @HttpCode(200)
  async message(
    @Headers('x-ingest-secret') secret: string | undefined,
    @Headers('x-test-now') testNow: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: boolean; replies?: string[] }> {
    this.guard.assertIngestSecret(secret);

    const fields = body as { text?: unknown; userId?: unknown } | null | undefined;
    const raw = fields?.text;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text || text.length > INGEST_MAX_TEXT_CHARS) {
      throw new BadRequestException(INVALID_TEXT);
    }

    const userId = parseIngestUserId(fields?.userId);
    if (userId === undefined) {
      throw new BadRequestException(INVALID_USER);
    }

    // The gate runs before any model call or Telegram message, as it does for the webhook.
    if (!this.telegram.isAllowedUserId(userId)) {
      this.logger.warn(`Rejected ingest: user ${userId} is not in ALLOWED_USERS`);
      throw new ForbiddenException(USER_NOT_ALLOWED);
    }

    // Same reflect/X-Test-Now trust boundary as the webhook and /sweep: test function only.
    const reflect = this.config.get<string>('TEST_REFLECT_REPLY')?.trim() === 'true';
    const sink: string[] | undefined = reflect ? [] : undefined;
    const nowOverride = reflect ? testNow?.trim() || undefined : undefined;

    try {
      await this.telegram.handleIngestedText(userId, text, sink, nowOverride);
    } catch (error) {
      // The user id only - never the text, which may be health data.
      this.logger.error(`Failed to handle ingested message for user ${userId}`, error as Error);
    }

    return sink ? { ok: true, replies: sink } : { ok: true };
  }

  /**
   * The morning digest for one user, called by the morning job (spec 0022) - not by `/sweep` and not
   * on the bot's own clock. Checks run in the same fixed order as `/ingest/message`: 401 for a wrong
   * secret or unconfigured ingest, 400 invalid_user for a bad `userId`, 403 user_not_allowed for a
   * user outside `ALLOWED_USERS` - and that 403 comes before anything is read or sent.
   *
   * After validation the answer is always 200: `sent` says whether a digest went out and `reason`
   * why not (`disabled`, `already_sent`, `empty`, `send_failed`). A failure is logged by user id and
   * still answers 200, with `sent: false` and no reason.
   */
  @Post('digest')
  @HttpCode(200)
  async digest(
    @Headers('x-ingest-secret') secret: string | undefined,
    @Headers('x-test-now') testNow: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: boolean; sent: boolean; reason?: DigestSkipReason; replies?: string[] }> {
    this.guard.assertIngestSecret(secret);

    const fields = body as { userId?: unknown } | null | undefined;
    const userId = parseIngestUserId(fields?.userId);
    if (userId === undefined) {
      throw new BadRequestException(INVALID_USER);
    }

    // The gate precedes every read of the user's settings and reminders, and every send.
    if (!this.telegram.isAllowedUserId(userId)) {
      this.logger.warn(`Rejected digest: user ${userId} is not in ALLOWED_USERS`);
      throw new ForbiddenException(USER_NOT_ALLOWED);
    }

    // Same reflect/X-Test-Now trust boundary as /ingest/message and /sweep: test function only.
    const reflect = this.config.get<string>('TEST_REFLECT_REPLY')?.trim() === 'true';
    const sink: string[] | undefined = reflect ? [] : undefined;
    const nowOverride = reflect ? testNow?.trim() || undefined : undefined;

    let result: { sent: boolean; reason?: DigestSkipReason } = { sent: false };
    try {
      result = await this.digestRunner.run(userId, this.clock.now(nowOverride), sink);
    } catch (error) {
      // The user id only - never the digest, which lists the user's own notes.
      this.logger.error(`Failed to run the digest for user ${userId}`, error as Error);
    }

    const response = {
      ok: true,
      sent: result.sent,
      ...(result.reason ? { reason: result.reason } : {}),
    };
    return sink ? { ...response, replies: sink } : response;
  }
}
