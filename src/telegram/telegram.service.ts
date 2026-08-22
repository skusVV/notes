import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { TelegramUpdate, TelegramUser } from './telegram.types';

function describeSender(from: TelegramUser | undefined): string {
  if (!from) {
    return 'user id unknown';
  }

  return from.username ? `user ${from.id} (@${from.username})` : `user ${from.id}`;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly api: AxiosInstance;
  private readonly allowedUsers: Set<number>;

  constructor(private readonly config: ConfigService) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not set');
    }

    this.api = axios.create({
      baseURL: `https://api.telegram.org/bot${token}`,
      timeout: 10_000,
    });

    this.allowedUsers = this.parseAllowedUsers();
  }

  private parseAllowedUsers(): Set<number> {
    const raw = this.config.get<string>('ALLOWED_USERS')?.trim();
    if (!raw) {
      this.logger.warn('ALLOWED_USERS is not set - every Telegram user may use this bot');
      return new Set();
    }

    const ids = new Set<number>();
    for (const entry of raw.split(',')) {
      const value = entry.trim();
      if (!value) {
        continue;
      }

      const id = Number(value);
      if (!Number.isSafeInteger(id)) {
        this.logger.warn(`Ignoring invalid ALLOWED_USERS entry: "${value}"`);
        continue;
      }

      ids.add(id);
    }

    this.logger.log(`ALLOWED_USERS restricts access to ${ids.size} user id(s)`);
    return ids;
  }

  private isAllowed(from: TelegramUser | undefined): boolean {
    if (this.allowedUsers.size === 0) {
      return true;
    }

    // With an allowlist configured, an update we cannot attribute to a user is never allowed.
    return from !== undefined && this.allowedUsers.has(from.id);
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message ?? update.edited_message;
    const sender = describeSender(message?.from);
    const text = message?.text;

    if (!message || !text) {
      this.logger.log(`Ignoring update ${update.update_id} from ${sender}: no text message`);
      return;
    }

    this.logger.log(`Received message from ${sender} in chat ${message.chat.id}`);

    if (!this.isAllowed(message.from)) {
      this.logger.warn(`Denied ${sender}: not in ALLOWED_USERS`);
      // Tell them their own id so it can be added to the allowlist if that was a mistake.
      const id = message.from ? ` Your user id is ${message.from.id}.` : '';
      await this.sendMessage(message.chat.id, `Sorry, you are not allowed to use this bot.${id}`);
      return;
    }

    await this.sendMessage(message.chat.id, text);
    this.logger.log(`Echoed message back to ${sender}`);
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    await this.api.post('/sendMessage', { chat_id: chatId, text });
  }
}
