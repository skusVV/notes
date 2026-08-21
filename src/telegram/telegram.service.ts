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

  constructor(private readonly config: ConfigService) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not set');
    }

    this.api = axios.create({
      baseURL: `https://api.telegram.org/bot${token}`,
      timeout: 10_000,
    });
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
    await this.sendMessage(message.chat.id, text);
    this.logger.log(`Echoed message back to ${sender}`);
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    await this.api.post('/sendMessage', { chat_id: chatId, text });
  }
}
