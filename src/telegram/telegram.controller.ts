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
import { ClockService } from '../clock/clock.service';
import { SweeperService } from './sweeper.service';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.types';

@Controller()
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(
    private readonly telegram: TelegramService,
    private readonly sweeper: SweeperService,
    private readonly clock: ClockService,
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
    @Headers('x-test-now') testNow: string | undefined,
    @Body() update: TelegramUpdate,
  ): Promise<{ ok: boolean; replies?: string[] }> {
    this.assertSecret(secret);

    // Reflect mode is set only on the test function (TEST_REFLECT_REPLY=true). When on, collect the
    // replies this update produces and return them in the response body, so the verifier can assert
    // on them over plain HTTP with no GCP identity. Off in production, so the response is unchanged.
    const reflect = this.config.get<string>('TEST_REFLECT_REPLY')?.trim() === 'true';
    const sink: string[] | undefined = reflect ? [] : undefined;

    // X-Test-Now pins "now" for relative-date resolution, but only on the test function - the same
    // trust boundary as reply reflection. Production has TEST_REFLECT_REPLY=false, so it is ignored.
    const nowOverride = reflect ? testNow?.trim() || undefined : undefined;

    try {
      await this.telegram.handleUpdate(update, sink, nowOverride);
    } catch (error) {
      // Always answer 200 so Telegram does not retry the same update forever.
      this.logger.error(`Failed to handle update ${update?.update_id}`, error as Error);
    }

    return sink ? { ok: true, replies: sink } : { ok: true };
  }

  /**
   * The Cloud Scheduler tick. Authenticated with its own shared secret rather than the webhook's,
   * because it is a different caller: Google's scheduler, not Telegram.
   *
   * Always answers 200 on success even if individual deliveries failed - a 5xx would make Cloud
   * Scheduler retry a run that has already flipped reminders to `sent`.
   */
  @Post('sweep')
  @HttpCode(200)
  async sweep(
    @Headers('x-sweep-secret') secret: string | undefined,
    @Headers('x-test-now') testNow: string | undefined,
  ): Promise<{ ok: boolean; replies?: string[] }> {
    this.assertSweepSecret(secret);

    // Same reflect/X-Test-Now trust boundary as the webhook: test function only.
    const reflect = this.config.get<string>('TEST_REFLECT_REPLY')?.trim() === 'true';
    const sink: string[] | undefined = reflect ? [] : undefined;
    const nowOverride = reflect ? testNow?.trim() || undefined : undefined;

    try {
      await this.sweeper.sweep(this.clock.now(nowOverride), sink);
    } catch (error) {
      this.logger.error('Sweep failed', error as Error);
    }

    return sink ? { ok: true, replies: sink } : { ok: true };
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

  /**
   * Unlike the webhook secret, a missing `REMINDER_SWEEP_SECRET` closes this endpoint instead of
   * skipping the check. An unauthenticated sweep would let anyone on the internet make the bot
   * deliver, so "not configured" fails closed.
   */
  private assertSweepSecret(received: string | undefined): void {
    const expected = this.sweeper.secret;
    if (!expected) {
      this.logger.warn('Rejected sweep: REMINDER_SWEEP_SECRET is not set, the endpoint is disabled');
      throw new UnauthorizedException();
    }

    const a = Buffer.from(received?.trim() ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      // Lengths only, never either secret - same as the webhook check.
      this.logger.warn(
        `Rejected sweep: secret mismatch (received ${a.length} chars, expected ${b.length})`,
      );
      throw new UnauthorizedException();
    }
  }
}
