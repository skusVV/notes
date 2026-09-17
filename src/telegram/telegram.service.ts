import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { ClassifierService } from '../classifier/classifier.service';
import {
  Classification,
  ClassificationResult,
  CONFIDENCE_ASK,
  CONFIDENCE_QUIET,
  fallbackResult,
} from '../classifier/classifier.types';
import { ClockService } from '../clock/clock.service';
import { normalizeEventAt } from '../reminders/event-at';
import { DueReminder, RemindersService } from '../reminders/reminders.service';
import { TranscriptionService } from '../transcription/transcription.service';
import {
  InlineKeyboardMarkup,
  TelegramApiResponse,
  TelegramCallbackQuery,
  TelegramFile,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
  TelegramVoice,
} from './telegram.types';

const DEFAULT_MAX_VOICE_SECONDS = 300;

// /version reports the running build's version. It is read from package.json at module load rather
// than hardcoded, so a release bump there is the single source of truth and the number is never
// invented. package.json sits two levels above this file both in source (src/telegram) and in the
// compiled bundle (dist/telegram), so the same relative path resolves in dev, tests, and deploy.
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

// Gemini caps a request at 20 MB *including* the base64 payload, which inflates bytes by ~4/3,
// so the raw audio ceiling is ~15 MB. Telegram's getFile download caps at 20 MB anyway. A
// five-minute voice note is well under 1 MB, so this only ever catches something pathological.
const MAX_VOICE_BYTES = 15 * 1024 * 1024;

// sendMessage rejects anything longer, and a few minutes of speech transcribes past it.
const MAX_MESSAGE_CHARS = 4096;

// Reminders are stored now, but the other intents are still only previewed. This notice is
// appended only to a reply that did NOT store everything it acted on, so it never contradicts a
// reminder the bot actually kept. Remove it as each remaining intent gains storage.
const NOT_STORED_NOTICE = '(only reminders are stored so far - other kinds of message are not kept yet)';

const HELP_TEXT = [
  'Send me a note, a reminder, a symptom, or a question - typed or as a voice message.',
  '',
  'I work out which one it is and show you what I understood.',
  'Reminders with a clear date and time are saved; other kinds are not kept yet.',
  'When a reminder is due I send it with OK / +1h / Tomorrow buttons.',
  '',
  '/export - show your stored reminders as JSON',
  '/help - this message',
].join('\n');

/** The hour of the local day the `Tomorrow` button snoozes to. */
export const SNOOZE_TOMORROW_HOUR = 9;

/** What the three delivery buttons do. The value is the middle field of the `callback_data`. */
export type ReminderAction = 'ok' | '1h' | 'tmrw';

const REMINDER_ACTIONS: readonly ReminderAction[] = ['ok', '1h', 'tmrw'];

/** `callback_data` is namespaced so a later feature's buttons cannot be mistaken for these. */
const CALLBACK_PREFIX = 'rem';

export interface ReminderCallback {
  action: ReminderAction;
  id: string;
}

/**
 * Parses a delivery button's `callback_data`, which is always exactly `rem:<action>:<reminderId>`.
 * Anything else - another feature's button, a truncated value, an unknown action - returns
 * `undefined` so the caller refuses instead of guessing. Firestore auto-ids contain no colon, so
 * a strict three-field split is safe.
 */
export function parseCallbackData(data: string | undefined): ReminderCallback | undefined {
  const parts = data?.trim().split(':') ?? [];
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX) {
    return undefined;
  }

  const [, action, id] = parts;
  if (!id || !REMINDER_ACTIONS.includes(action as ReminderAction)) {
    return undefined;
  }

  return { action: action as ReminderAction, id };
}

/**
 * The three buttons on a delivered reminder. `callback_data` stays well under Telegram's 64-byte
 * limit: the prefix and action are 8 characters at most and a Firestore auto-id is 20.
 */
export function reminderKeyboard(id: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'OK', callback_data: `${CALLBACK_PREFIX}:ok:${id}` },
        { text: '+1h', callback_data: `${CALLBACK_PREFIX}:1h:${id}` },
        { text: 'Tomorrow', callback_data: `${CALLBACK_PREFIX}:tmrw:${id}` },
      ],
    ],
  };
}

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
    private readonly classifier: ClassifierService,
    private readonly reminders: RemindersService,
    private readonly clock: ClockService,
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

  // `sink`, when provided, collects every reply this update produces. The test function passes one
  // (via TEST_REFLECT_REPLY) so the verifier can read replies straight from the HTTP response
  // without a GCP identity; production passes nothing and behaviour is unchanged.
  //
  // `nowOverride` is the X-Test-Now value, forwarded only by the test function (same trust boundary
  // as `sink`); it pins "now" for this one update so relative-date resolution is deterministic.
  async handleUpdate(update: TelegramUpdate, sink?: string[], nowOverride?: string): Promise<void> {
    // A delivery button tap arrives as its own update kind, so it is handled before the
    // message branches. It rides the same webhook, so it is already behind the secret check.
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query, this.clock.now(nowOverride), sink);
      return;
    }

    const message = update.message ?? update.edited_message;
    if (!message) {
      this.logger.log(`Ignoring update ${update.update_id}: no message`);
      return;
    }

    // One instant for the whole update: the classifier resolves relative dates against it and a
    // stored reminder's createdAt uses it, so a pinned test clock stays consistent across both.
    const now = this.clock.now(nowOverride);

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

    // The gate must precede voice handling and classification, both of which cost money.
    if (!this.isAllowed(message.from)) {
      this.logger.warn(`Denied ${sender}: not in ALLOWED_USERS`);
      await this.sendMessage(message.chat.id, 'Sorry, you are not allowed to use this bot.', sink);
      return;
    }

    // Commands are routed deterministically and never reach the model. Telegram sends /start
    // on first contact, so without this the very first message would be classified as prose.
    if (text?.startsWith('/')) {
      await this.handleCommand(message.chat.id, text, message.from, sender, sink);
      return;
    }

    if (voice) {
      await this.handleVoice(message, voice, sender, now, sink);
      return;
    }

    if (text) {
      await this.route(message.chat.id, text, message.from, sender, now, undefined, sink);
    }
  }

  /**
   * Sends one due reminder with its OK / +1h / Tomorrow keyboard. Called by the sweeper, only ever
   * for a reminder it has already claimed, so this method never decides whether to deliver.
   */
  async sendReminder(reminder: DueReminder, sink?: string[]): Promise<void> {
    const lines = [`Reminder: ${reminder.title}`];
    if (reminder.eventAt) {
      lines.push(`when: ${reminder.eventAt}`);
    }

    await this.sendMessage(reminder.chatId, lines.join('\n'), sink, reminderKeyboard(reminder.id));
  }

  /**
   * A delivery button tap: gate, owner check, then act. The gate runs before anything reads or
   * writes Firestore, and the owner check means a reminder is only ever moved by the person who
   * created it. Telegram shows a spinner on the tapped button until `answerCallbackQuery` replies,
   * so every path through here answers - including the refusals.
   */
  private async handleCallbackQuery(
    query: TelegramCallbackQuery,
    now: Date,
    sink?: string[],
  ): Promise<void> {
    const sender = describeSender(query.from);
    const tap = parseCallbackData(query.data);

    // The reminder id, the action, and the sender - never the reminder's contents.
    this.logger.log(
      `Received callback ${tap?.action ?? 'unparseable'} from ${sender} for reminder ${tap?.id ?? 'none'}`,
    );

    // The gate precedes every read and write, exactly as it does for messages.
    if (!this.isAllowed(query.from)) {
      this.logger.warn(`Denied ${sender}: not in ALLOWED_USERS`);
      await this.answerCallback(query.id, 'Sorry, you are not allowed to use this bot.', sink);
      return;
    }

    if (!tap) {
      await this.answerCallback(query.id, 'I do not recognise that button.', sink);
      return;
    }

    if (!this.reminders.available) {
      await this.answerCallback(query.id, 'I cannot reach my store right now.', sink);
      return;
    }

    try {
      // Owner check. A reminder belonging to somebody else - or one that no longer exists - is
      // refused with no state change at all.
      const owned = await this.reminders.getOwned(query.from.id, tap.id);
      if (!owned) {
        this.logger.warn(`Refused callback from ${sender}: reminder ${tap.id} is not theirs`);
        await this.answerCallback(query.id, 'That reminder is not yours.', sink);
        return;
      }

      await this.applyCallback(tap, query, now, sink);
    } catch (error) {
      this.logger.error(`Failed to apply callback for reminder ${tap.id}`, error as Error);
      await this.answerCallback(query.id, 'Sorry, that did not go through.', sink);
    }
  }

  /** The three button branches. A snooze moves `remindAt` only; `eventAt` is never touched. */
  private async applyCallback(
    tap: ReminderCallback,
    query: TelegramCallbackQuery,
    now: Date,
    sink?: string[],
  ): Promise<void> {
    const userId = query.from.id;
    const timezone = this.classifier.defaultTimezone;

    if (tap.action === 'ok') {
      await this.reminders.ack(userId, tap.id, now);
      await this.answerCallback(query.id, 'Done.', sink);
      // Best effort: the reminder is already acked, so a failure here is cosmetic.
      await this.removeKeyboard(query.message);
      return;
    }

    const remindAt =
      tap.action === '1h'
        ? this.clock.plusHours(now, 1)
        : this.clock.nextDayAt(now, timezone, SNOOZE_TOMORROW_HOUR);

    await this.reminders.snooze(userId, tap.id, remindAt);
    await this.answerCallback(
      query.id,
      `I will remind you again at ${this.clock.formatLocal(remindAt, timezone)}.`,
      sink,
    );
  }

  /** Stops Telegram's spinner on the tapped button. Reflected too, so a test can read the outcome. */
  private async answerCallback(callbackId: string, text: string, sink?: string[]): Promise<void> {
    if (sink) {
      sink.push(text);
    }

    try {
      await this.api.post('/answerCallbackQuery', { callback_query_id: callbackId, text });
    } catch (error) {
      this.logger.warn(`answerCallbackQuery failed: ${(error as Error).message}`);
    }
  }

  /** Clears the buttons off an acknowledged delivery so it cannot be tapped twice. */
  private async removeKeyboard(message: TelegramMessage | undefined): Promise<void> {
    if (!message) {
      return;
    }

    try {
      await this.api.post('/editMessageReplyMarkup', {
        chat_id: message.chat.id,
        message_id: message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (error) {
      this.logger.warn(`editMessageReplyMarkup failed: ${(error as Error).message}`);
    }
  }

  private async handleCommand(
    chatId: number,
    text: string,
    from: TelegramUser | undefined,
    sender: string,
    sink?: string[],
  ): Promise<void> {
    const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();
    this.logger.log(`Handling command ${command} from ${sender}`);

    if (command === '/start' || command === '/help') {
      await this.sendMessage(chatId, HELP_TEXT, sink);
      return;
    }

    if (command === '/version') {
      await this.sendMessage(chatId, `notes-bot ${PACKAGE_VERSION}`, sink);
      return;
    }

    if (command === '/export') {
      await this.handleExport(chatId, from, sender, sink);
      return;
    }

    await this.sendMessage(chatId, `I do not know ${command}. Try /help.`, sink);
  }

  /**
   * Dumps the requesting user's stored reminders as one JSON object `{"reminders":[...]}`. Read
   * back by the verifier over HTTP; assertions are made on this structure, never on reply wording.
   * The output embeds the user's own words, so it is never logged - only its item count is.
   */
  private async handleExport(
    chatId: number,
    from: TelegramUser | undefined,
    sender: string,
    sink?: string[],
  ): Promise<void> {
    let reminders: Awaited<ReturnType<RemindersService['list']>> = [];
    if (from && this.reminders.available) {
      try {
        reminders = await this.reminders.list(from.id);
      } catch (error) {
        this.logger.error(`Failed to export reminders for ${sender}`, error as Error);
      }
    }

    this.logger.log(`Exported ${reminders.length} reminder(s) for ${sender}`);
    await this.sendMessage(chatId, JSON.stringify({ reminders }), sink);
  }

  private async handleVoice(
    message: TelegramMessage,
    voice: TelegramVoice,
    sender: string,
    now: Date,
    sink?: string[],
  ): Promise<void> {
    const chatId = message.chat.id;

    if (!this.transcription.available) {
      this.logger.warn(`Cannot transcribe for ${sender}: transcription is not configured`);
      await this.sendMessage(chatId, 'Voice transcription is not configured on this bot yet.', sink);
      return;
    }

    if (voice.duration > this.maxVoiceSeconds) {
      this.logger.warn(
        `Rejected ${voice.duration}s voice message from ${sender}: over ${this.maxVoiceSeconds}s`,
      );
      await this.sendMessage(
        chatId,
        `That voice message is ${voice.duration}s long. I only transcribe up to ${this.maxVoiceSeconds}s.`,
        sink,
      );
      return;
    }

    if (voice.file_size !== undefined && voice.file_size > MAX_VOICE_BYTES) {
      this.logger.warn(`Rejected ${voice.file_size} byte voice message from ${sender}: too large`);
      await this.sendMessage(chatId, 'That voice message is too large for me to transcribe.', sink);
      return;
    }

    let transcript: string;
    try {
      await this.indicateWork(chatId);

      const audio = await this.downloadFile(voice.file_id);
      transcript = await this.transcription.transcribe(audio, voice.mime_type ?? 'audio/ogg');

      // Log the length, not the text: these are the user's private notes.
      this.logger.log(
        `Transcribed ${voice.duration}s of audio from ${sender} into ${transcript.length} chars`,
      );
    } catch (error) {
      this.logger.error(`Failed to transcribe voice message from ${sender}`, error as Error);
      await this.sendMessage(chatId, 'Sorry, I could not transcribe that voice message.', sink);
      return;
    }

    if (!transcript) {
      await this.sendMessage(chatId, 'I could not hear any speech in that voice message.', sink);
      return;
    }

    // Voice and text converge here: from this point nothing downstream knows which it was.
    // The transcript is echoed because it is the user's only evidence that speech recognition
    // heard them correctly.
    await this.route(chatId, transcript, message.from, sender, now, `"${transcript}"`, sink);
  }

  /**
   * The branch point. Classifies the message, then dispatches each intent to its own handler.
   * A classification failure degrades to `other` rather than blocking the reply.
   */
  private async route(
    chatId: number,
    text: string,
    from: TelegramUser | undefined,
    sender: string,
    now: Date,
    prefix?: string,
    sink?: string[],
  ): Promise<void> {
    if (!this.classifier.available) {
      this.logger.warn(`Cannot classify for ${sender}: classifier is not configured`);
      await this.sendMessage(chatId, [prefix, text].filter(Boolean).join('\n\n'), sink);
      return;
    }

    const timezone = this.classifier.defaultTimezone;
    let result: ClassificationResult;
    try {
      if (!prefix) {
        // Voice already showed a typing hint before transcribing.
        await this.indicateWork(chatId);
      }

      result = await this.classifier.classify(text, {
        timezone,
        // The classifier needs the current local time to turn "Thursday" into a real date.
        now: this.clock.formatLocal(now, timezone),
        // Empty until the rest of Firestore lands. The shape is here now so later specs only fill
        // it in: known vocabulary is what stops the model inventing a new slug for every wording,
        // and previousText is the only way a correction can be recognised.
        knownSymptomTypes: [],
        knownActors: [],
        previousText: undefined,
      });
    } catch (error) {
      this.logger.error(`Failed to classify message from ${sender}`, error as Error);
      result = fallbackResult(text);
    }

    this.logger.log(
      `Classified message from ${sender} as [${result.items
        .map((item) => `${item.intent} ${item.confidence.toFixed(2)}`)
        .join(', ')}] lang=${result.language} mentions=${result.mentions.length}`,
    );

    const lines: string[] = [];
    if (prefix) {
      lines.push(prefix, '');
    }

    let needsClarification = false;
    // Whether the reply acted on anything that was NOT a successfully stored reminder. Drives the
    // conditional NOT_STORED_NOTICE: a reply that only stored reminders must not carry it, and it
    // must never falsely claim a store the bot did not make.
    let hasUnstored = false;
    for (const item of result.items) {
      if (item.confidence < CONFIDENCE_ASK) {
        needsClarification = true;
        hasUnstored = true;
        lines.push(this.describeUnsure(item));
        continue;
      }

      if (item.intent === 'reminder') {
        const outcome = await this.handleReminder(item, from, chatId, text, now, sender);
        lines.push(outcome.text);
        if (!outcome.stored) {
          hasUnstored = true;
        }
        continue;
      }

      hasUnstored = true;
      lines.push(this.describeItem(item, result));
    }

    if (needsClarification) {
      lines.push('', 'Which is it - a note, a reminder, a symptom, or a question?');
    }

    if (hasUnstored) {
      lines.push('', NOT_STORED_NOTICE);
    }
    await this.sendMessage(chatId, lines.join('\n'), sink);
  }

  /**
   * The reminder branch: persist a resolved reminder and confirm the stored time, or explain why
   * it could not be stored. The item is already at or above CONFIDENCE_ASK here, which - given the
   * classifier's validation - means it carries a resolvable future eventAt; create() re-validates
   * and a rejection is still handled without claiming a store.
   */
  private async handleReminder(
    item: Classification,
    from: TelegramUser | undefined,
    chatId: number,
    originalText: string,
    now: Date,
    sender: string,
  ): Promise<{ text: string; stored: boolean }> {
    const reminder = item.reminder;
    if (!reminder) {
      // Should not happen above CONFIDENCE_ASK, but never invent a store if it does.
      return { text: this.describeReminder(item), stored: false };
    }

    if (!from || !this.reminders.available) {
      return {
        text: `${this.describeReminder(item)}\nI could not store this reminder right now.`,
        stored: false,
      };
    }

    try {
      const id = await this.reminders.create(
        from.id,
        chatId,
        { title: reminder.title, eventAt: reminder.eventAt },
        originalText,
        now,
      );
      if (!id) {
        return {
          text: `${this.describeReminder(item)}\nI could not work out a clear time, so I did not store it.`,
          stored: false,
        };
      }

      const resolved = normalizeEventAt(reminder.eventAt, now) ?? reminder.eventAt ?? '';
      return { text: `Reminder saved: ${reminder.title}\nwhen: ${resolved}`, stored: true };
    } catch (error) {
      this.logger.error(`Failed to store reminder for ${sender}`, error as Error);
      return {
        text: `${this.describeReminder(item)}\nI could not store this reminder right now.`,
        stored: false,
      };
    }
  }

  /**
   * One branch per intent. Each of these becomes a write once Firestore exists; for now the
   * branch is where the reply is composed, so the routing itself is observable.
   */
  private describeItem(item: Classification, result: ClassificationResult): string {
    switch (item.intent) {
      case 'reminder':
        return this.describeReminder(item);
      case 'symptom':
        return this.describeSymptom(item);
      case 'question':
        return this.describeQuestion(item);
      case 'actor_info':
        return this.withConfidence(
          `About ${result.mentions.join(', ') || 'someone'}: ${item.summary}`,
          item,
        );
      case 'correction':
        // Correction needs the previous message, which nothing stores yet.
        return this.withConfidence(
          `Correction: ${item.summary}\nI cannot apply it yet - nothing is stored to correct.`,
          item,
        );
      case 'note':
        return this.withConfidence(`Note: ${item.summary}`, item);
      case 'other':
      default:
        return `Not sure what that was, so I would keep it as a plain note.`;
    }
  }

  private describeReminder(item: Classification): string {
    const reminder = item.reminder;
    if (!reminder) {
      return this.withConfidence(`Reminder: ${item.summary}`, item);
    }

    const details: string[] = [`Reminder: ${reminder.title}`];
    details.push(reminder.eventAt ? `when: ${reminder.eventAt}` : 'when: not stated');
    details.push(
      reminder.leadMinutes === undefined
        ? 'lead time: not stated, I would ask'
        : `lead time: ${reminder.leadMinutes} min before`,
    );
    if (reminder.recurrence) {
      details.push(`repeats: ${reminder.recurrence}`);
    }

    return this.withConfidence(details.join('\n'), item);
  }

  private describeSymptom(item: Classification): string {
    const symptom = item.symptom;
    if (!symptom) {
      return this.withConfidence(`Symptom: ${item.summary}`, item);
    }

    const details: string[] = [`Symptom: ${symptom.type}`];
    details.push(
      symptom.severity === undefined
        ? 'severity: not stated'
        : `severity: ${symptom.severity}/10`,
    );
    if (symptom.startedAt) {
      details.push(`started: ${symptom.startedAt}`);
    }
    if (symptom.durationMinutes !== undefined) {
      details.push(`lasted: ${symptom.durationMinutes} min`);
    }

    return this.withConfidence(details.join('\n'), item);
  }

  private describeQuestion(item: Classification): string {
    const question = item.question;
    const details: string[] = [`Question (${question?.shape ?? 'semantic'})`];
    if (question?.topic) {
      details.push(`topic: ${question.topic}`);
    }
    if (question?.symptomType) {
      details.push(`symptom: ${question.symptomType}`);
    }
    if (question?.from || question?.to) {
      details.push(`range: ${question.from ?? 'any'} to ${question.to ?? 'now'}`);
    }
    details.push('I cannot answer it yet - there is no history to search.');

    return this.withConfidence(details.join('\n'), item);
  }

  private describeUnsure(item: Classification): string {
    const guess = item.intent === 'other' ? 'anything I handle' : item.intent;
    return `I am not confident this is ${guess} (${item.confidence.toFixed(2)}): ${item.summary}`;
  }

  /** The middle confidence band is shown, so a plausible-but-wrong reading is catchable. */
  private withConfidence(body: string, item: Classification): string {
    if (item.confidence >= CONFIDENCE_QUIET) {
      return body;
    }
    return `${body}\nnot fully sure (${item.confidence.toFixed(2)})`;
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

  /** Cosmetic "typing" hint. The model takes seconds, and silence reads as a broken bot. */
  private async indicateWork(chatId: number): Promise<void> {
    try {
      await this.api.post('/sendChatAction', { chat_id: chatId, action: 'typing' });
    } catch (error) {
      this.logger.warn(`sendChatAction failed for chat ${chatId}: ${(error as Error).message}`);
    }
  }

  private async sendMessage(
    chatId: number,
    text: string,
    sink?: string[],
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    // Deliberately no parse_mode: replies embed the user's own words, and Markdown or HTML
    // would break on any stray underscore or angle bracket in a transcript. Buttons ride on
    // reply_markup instead, which is orthogonal to text formatting.
    const chunks = splitForTelegram(text);

    // Reflect mode (test function only): record every chunk so the verifier can read replies from
    // the HTTP response, and tolerate a failing Telegram send so a throwaway chat id does not abort
    // the rest. Production passes no sink, so behaviour and error propagation are unchanged.
    if (sink) {
      sink.push(...chunks);
    }

    for (const [index, chunk] of chunks.entries()) {
      try {
        // The keyboard goes on the last chunk so the buttons sit under the whole message.
        const markup = replyMarkup && index === chunks.length - 1 ? replyMarkup : undefined;
        await this.api.post('/sendMessage', {
          chat_id: chatId,
          text: chunk,
          ...(markup ? { reply_markup: markup } : {}),
        });
      } catch (error) {
        if (!sink) {
          throw error;
        }
        this.logger.warn(
          `reflect: sendMessage to chat ${chatId} failed: ${(error as Error).message}`,
        );
      }
    }
  }
}
