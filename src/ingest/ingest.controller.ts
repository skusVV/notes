import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from '../telegram/telegram.service';
import { IngestGuard } from './ingest.guard';

/** Longest text `/ingest/message` accepts, after trimming. A dictated thought is far shorter. */
export const INGEST_MAX_TEXT_CHARS = 4000;

/** The 400 body for a missing, empty or oversized `text`. */
const INVALID_TEXT = { ok: false, error: 'invalid_text' } as const;

@Controller('ingest')
export class IngestController {
  private readonly logger = new Logger(IngestController.name);

  constructor(
    private readonly guard: IngestGuard,
    private readonly telegram: TelegramService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Quick capture from the owner's phone: the text goes down exactly the path a chat message takes
   * (allowlist, commands, classification, storage, reply in Telegram).
   *
   * 401 before anything else when the secret is wrong or ingest is not configured. A bad `text` is
   * a 400 - the caller is the owner's own Shortcut, which benefits from seeing the error, and there
   * is no Telegram retry loop here. A failure *after* validation is logged and still answers 200,
   * for the same reason the webhook does.
   */
  @Post('message')
  @HttpCode(200)
  async message(
    @Headers('x-ingest-secret') secret: string | undefined,
    @Headers('x-test-now') testNow: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: boolean; replies?: string[] }> {
    const userId = this.guard.assertIngestSecret(secret);

    const raw = (body as { text?: unknown } | undefined)?.text;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text || text.length > INGEST_MAX_TEXT_CHARS) {
      throw new BadRequestException(INVALID_TEXT);
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
}
