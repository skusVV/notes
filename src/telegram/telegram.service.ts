import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { TranscriptionService } from '../transcription/transcription.service';
import {
  TelegramApiResponse,
  TelegramFile,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
  TelegramVoice,
} from './telegram.types';

const DEFAULT_MAX_VOICE_SECONDS = 300;

// Gemini caps a request at 20 MB *including* the base64 payload, which inflates bytes by ~4/3,
// so the raw audio ceiling is ~15 MB. Telegram's getFile download caps at 20 MB anyway. A
// five-minute voice note is well under 1 MB, so this only ever catches something pathological.
const MAX_VOICE_BYTES = 15 * 1024 * 1024;

// sendMessage rejects anything longer, and a few minutes of speech transcribes past it.
const MAX_MESSAGE_CHARS = 4096;

function describeSender(from: TelegramUser | undefined): string {
  if (!from) {
    return 'user id unknown';
  }

  return from.username ? `user ${from.id} (@${from.username})` : `user ${from.id}`;
}

/** Splits a long transcript into chunks Telegram will accept, breaking at whitespace. */
function splitForTelegram(text: string): string[] {
  if (text.length <= MAX_MESSAGE_CHARS) {
    return text ? [text] : [];
  }

  const parts: string[] = [];
  let rest = text;

  while (rest.length > MAX_MESSAGE_CHARS) {
    const window = rest.slice(0, MAX_MESSAGE_CHARS);
    const breakAt = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    // Only honour a break point in the back half, otherwise a long unbroken run would
    // produce a stream of tiny messages.
    const at = breakAt > MAX_MESSAGE_CHARS / 2 ? breakAt : MAX_MESSAGE_CHARS;

    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }

  if (rest) {
    parts.push(rest);
  }

  return parts;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly api: AxiosInstance;
  private readonly files: AxiosInstance;
  private readonly allowedUsers: Set<number>;
  private readonly maxVoiceSeconds: number;

  constructor(
    private readonly config: ConfigService,
    private readonly transcription: TranscriptionService,
  ) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not set');
    }

    this.api = axios.create({
      baseURL: `https://api.telegram.org/bot${token}`,
      timeout: 10_000,
    });

    // File downloads live on a different host path than the Bot API methods.
    this.files = axios.create({
      baseURL: `https://api.telegram.org/file/bot${token}`,
      timeout: 30_000,
      responseType: 'arraybuffer',
    });

    this.allowedUsers = this.parseAllowedUsers();
    this.maxVoiceSeconds = this.parseMaxVoiceSeconds();
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

  private parseMaxVoiceSeconds(): number {
    const raw = this.config.get<string>('MAX_VOICE_SECONDS')?.trim();
    if (!raw) {
      return DEFAULT_MAX_VOICE_SECONDS;
    }

    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      this.logger.warn(
        `Ignoring invalid MAX_VOICE_SECONDS "${raw}", using ${DEFAULT_MAX_VOICE_SECONDS}`,
      );
      return DEFAULT_MAX_VOICE_SECONDS;
    }

    return value;
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
    if (!message) {
      this.logger.log(`Ignoring update ${update.update_id}: no message`);
      return;
    }

    const sender = describeSender(message.from);
    const { text, voice } = message;

    // Decide whether this is an update we handle *before* the allowlist check, so that
    // strangers sending stickers keep getting silence rather than a new refusal reply.
    if (!text && !voice) {
      this.logger.log(`Ignoring update ${update.update_id} from ${sender}: no text or voice`);
      return;
    }

    this.logger.log(
      `Received ${voice ? 'voice' : 'text'} message from ${sender} in chat ${message.chat.id}`,
    );

    // The gate must precede voice handling, which downloads a file and calls a paid model.
    if (!this.isAllowed(message.from)) {
      this.logger.warn(`Denied ${sender}: not in ALLOWED_USERS`);
      await this.sendMessage(message.chat.id, 'Sorry, you are not allowed to use this bot.');
      return;
    }

    if (text) {
      await this.sendMessage(message.chat.id, text);
      this.logger.log(`Echoed message back to ${sender}`);
      return;
    }

    if (voice) {
      await this.handleVoice(message, voice, sender);
    }
  }

  private async handleVoice(
    message: TelegramMessage,
    voice: TelegramVoice,
    sender: string,
  ): Promise<void> {
    const chatId = message.chat.id;

    if (!this.transcription.available) {
      this.logger.warn(`Cannot transcribe for ${sender}: transcription is not configured`);
      await this.sendMessage(chatId, 'Voice transcription is not configured on this bot yet.');
      return;
    }

    if (voice.duration > this.maxVoiceSeconds) {
      this.logger.warn(
        `Rejected ${voice.duration}s voice message from ${sender}: over ${this.maxVoiceSeconds}s`,
      );
      await this.sendMessage(
        chatId,
        `That voice message is ${voice.duration}s long. I only transcribe up to ${this.maxVoiceSeconds}s.`,
      );
      return;
    }

    if (voice.file_size !== undefined && voice.file_size > MAX_VOICE_BYTES) {
      this.logger.warn(`Rejected ${voice.file_size} byte voice message from ${sender}: too large`);
      await this.sendMessage(chatId, 'That voice message is too large for me to transcribe.');
      return;
    }

    try {
      await this.indicateWork(chatId);

      const audio = await this.downloadFile(voice.file_id);
      const transcript = await this.transcription.transcribe(
        audio,
        voice.mime_type ?? 'audio/ogg',
      );

      // Log the length, not the text: these are the user's private notes.
      this.logger.log(
        `Transcribed ${voice.duration}s of audio from ${sender} into ${transcript.length} chars`,
      );

      await this.sendMessage(
        chatId,
        transcript || 'I could not hear any speech in that voice message.',
      );
    } catch (error) {
      this.logger.error(`Failed to transcribe voice message from ${sender}`, error as Error);
      await this.sendMessage(chatId, 'Sorry, I could not transcribe that voice message.');
    }
  }

  private async downloadFile(fileId: string): Promise<Buffer> {
    const { data } = await this.api.post<TelegramApiResponse<TelegramFile>>('/getFile', {
      file_id: fileId,
    });

    const filePath = data.result?.file_path;
    if (!filePath) {
      throw new Error(`getFile returned no file_path for ${fileId}`);
    }

    const response = await this.files.get<ArrayBuffer>(`/${filePath}`);
    return Buffer.from(response.data);
  }

  /** Cosmetic "typing" hint. Transcription takes seconds, and silence reads as a broken bot. */
  private async indicateWork(chatId: number): Promise<void> {
    try {
      await this.api.post('/sendChatAction', { chat_id: chatId, action: 'typing' });
    } catch (error) {
      this.logger.warn(`sendChatAction failed for chat ${chatId}: ${(error as Error).message}`);
    }
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    for (const chunk of splitForTelegram(text)) {
      await this.api.post('/sendMessage', { chat_id: chatId, text: chunk });
    }
  }
}
