import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.types';

@Controller()
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(
    private readonly telegram: TelegramService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  health(): { status: string } {
    return { status: 'ok' };
  }

  @Post()
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: TelegramUpdate,
  ): Promise<{ ok: boolean }> {
    this.assertSecret(secret);

    try {
      await this.telegram.handleUpdate(update);
    } catch (error) {
      // Always answer 200 so Telegram does not retry the same update forever.
      this.logger.error(`Failed to handle update ${update?.update_id}`, error as Error);
    }

    return { ok: true };
  }

  private assertSecret(received: string | undefined): void {
    // Secret Manager values often carry a trailing newline; Telegram's token cannot contain
    // whitespace, so trimming can only help.
    const expected = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET')?.trim();
    if (!expected) {
      return;
    }

    const a = Buffer.from(received?.trim() ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      // Lengths only - enough to tell "webhook registered without a secret_token" (0 received)
      // from a genuine value mismatch, without logging either secret.
      this.logger.warn(
        `Rejected request: secret token mismatch (received ${a.length} chars, expected ${b.length})`,
      );
      throw new UnauthorizedException();
    }
  }
}
