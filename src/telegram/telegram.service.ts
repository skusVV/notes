import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { ActorsService, firstNewMention, isDeclineReply } from '../actors/actors.service';
import { ClassifierService } from '../classifier/classifier.service';
import {
  Classification,
  ClassificationResult,
  CONFIDENCE_ASK,
  CONFIDENCE_QUIET,
  fallbackResult,
} from '../classifier/classifier.types';
import { ClockService } from '../clock/clock.service';
import { NotesService } from '../notes/notes.service';
import { normalizeEventAt } from '../reminders/event-at';
import { humanizeInstant } from '../reminders/humanize-time';
import { describeRecurrence, nextOccurrence } from '../reminders/recurrence';
import {
  DueNotification,
  OwnedNotification,
  RemindersService,
} from '../reminders/reminders.service';
import { SymptomsService } from '../symptoms/symptoms.service';
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

// Reminders, notes and symptoms are stored now, but the other intents (question, actor_info,
// correction) are still only previewed - as is a note/other that failed to store, or a symptom the
// store could not keep. This notice is appended only to a reply that did NOT store everything it
// acted on, so it never contradicts something the bot actually kept. Remove it as each remaining
// intent gains storage.
const NOT_STORED_NOTICE =
  '(reminders, notes and symptoms are stored so far - other kinds of message are not kept yet)';

const HELP_TEXT = [
  'Send me a note, a reminder, a symptom, or a question - typed or as a voice message.',
  '',
  'I work out which one it is and show you what I understood.',
  'Reminders with a clear date and time are saved, stray notes are kept, and symptoms you report are logged; other kinds are not kept yet.',
  'When a reminder is due I send it with Готово / +1 год / Завтра buttons.',
  '',
  '/export - show your stored reminders, notes and symptoms as JSON',
  '/help - this message',
].join('\n');

/**
 * A stand-in message id, used only when the real `sendMessage` did not come back with one - which
 * in practice means reflect mode, where a throwaway chat id makes every send fail. The
 * pending-question flow keys on the id of the question it sent, so it needs one either way; a real
 * Telegram message id is a small per-chat integer, so starting far above that range keeps a
 * placeholder distinguishable and unique within this instance.
 */
const SYNTHETIC_MESSAGE_ID_BASE = 1_000_000_000;
let syntheticMessages = 0;

export function syntheticMessageId(): number {
  syntheticMessages += 1;
  return SYNTHETIC_MESSAGE_ID_BASE + syntheticMessages;
}

/** What the reflected webhook response reports when an actor question was asked. */
export interface ActorQuestion {
  mention: string;
  questionMessageId: number;
}

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
 * Parses a delivery button's `callback_data`, which is always exactly
 * `rem:<action>:<notificationId>` - the id of the one nudge that was delivered, not of the whole
 * reminder, so a button acts on that nudge alone. Anything else - another feature's button, a
 * truncated value, an unknown action - returns `undefined` so the caller refuses instead of
 * guessing. Firestore auto-ids contain no colon, so a strict three-field split is safe.
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
 * The three buttons on a delivered notification. `callback_data` stays well under Telegram's
 * 64-byte limit: the prefix and action are 8 characters at most and a Firestore auto-id is 20.
 */
export function reminderKeyboard(id: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'Готово', callback_data: `${CALLBACK_PREFIX}:ok:${id}` },
        { text: '+1 год', callback_data: `${CALLBACK_PREFIX}:1h:${id}` },
        { text: 'Завтра', callback_data: `${CALLBACK_PREFIX}:tmrw:${id}` },
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
    private readonly actors: ActorsService,
    private readonly notes: NotesService,
    private readonly symptoms: SymptomsService,
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
  //
  // `actorAsks` is the same trust boundary again: the test function passes one so the reflected
  // response can report the actor question this update produced, which is the only way a test can
  // reply to it. Production passes nothing.
  async handleUpdate(
    update: TelegramUpdate,
    sink?: string[],
    nowOverride?: string,
    actorAsks?: ActorQuestion[],
  ): Promise<void> {
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

    // A text reply to the bot's own "who is this?" question is an answer, not a new message, so it
    // is matched before commands and before classification - otherwise the answer would be filed as
    // prose. A reply that matches no open question falls straight through to normal handling.
    if (text && message.reply_to_message && message.from) {
      const answered = await this.handlePendingReply(message, text, message.from, sender, now, sink);
      if (answered) {
        return;
      }
    }

    // Commands are routed deterministically and never reach the model. Telegram sends /start
    // on first contact, so without this the very first message would be classified as prose.
    if (text?.startsWith('/')) {
      await this.handleCommand(message.chat.id, text, message.from, sender, sink);
      return;
    }

    if (voice) {
      await this.handleVoice(message, voice, sender, now, sink, actorAsks);
      return;
    }

    if (text) {
      await this.route(
        message.chat.id,
        text,
        message.from,
        sender,
        now,
        undefined,
        sink,
        message.message_id,
        actorAsks,
      );
    }
  }

  /**
   * Handles a reply to the open actor question, and reports whether it was one. Returns false for
   * every other reply - no open question, an expired one, or a different message id - so an
   * ordinary message that happens to be a reply is processed normally rather than swallowed.
   *
   * Anything that is not one of the decline phrases is stored as what the user said about that
   * person, verbatim. This is capture, not interpretation: no relation, no aliases, no labels.
   */
  private async handlePendingReply(
    message: TelegramMessage,
    text: string,
    from: TelegramUser,
    sender: string,
    now: Date,
    sink?: string[],
  ): Promise<boolean> {
    if (!this.actors.available) {
      return false;
    }

    const chatId = message.chat.id;
    let pending;
    try {
      pending = await this.actors.getPendingQuestion(from.id, chatId, now);
    } catch (error) {
      this.logger.error(`Failed to read the open actor question for ${sender}`, error as Error);
      return false;
    }

    if (!pending || pending.questionMessageId !== message.reply_to_message?.message_id) {
      return false;
    }

    const declined = isDeclineReply(text);
    try {
      if (declined) {
        await this.actors.decline(from.id, pending.mention);
      } else {
        await this.actors.create(from.id, { name: pending.mention, notes: text.trim() }, now);
      }
      await this.actors.clearPendingQuestion(from.id, chatId);
    } catch (error) {
      // Ids only - never the mention or what the user said about them.
      this.logger.error(`Failed to answer the actor question for ${sender}`, error as Error);
      await this.sendMessage(chatId, 'Sorry, I could not save that right now.', sink);
      return true;
    }

    this.logger.log(
      `Answered the actor question for ${sender}: ${declined ? 'declined' : 'actor stored'}`,
    );
    await this.sendMessage(
      chatId,
      declined ? 'Understood - I will not ask about them again.' : 'Noted, I will remember that.',
      sink,
    );
    return true;
  }

  /**
   * Sends one due notification with its OK / +1h / Tomorrow keyboard. Called by the sweeper, only
   * ever for a notification it has already claimed, so this method never decides whether to
   * deliver. The keyboard keys on the notification id, so a tap moves this nudge and no other.
   */
  async sendReminder(notification: DueNotification, now: Date, sink?: string[]): Promise<void> {
    const lines = [`Нагадування: ${notification.title}`];
    if (notification.eventAt) {
      lines.push(humanizeInstant(notification.eventAt, now));
    }

    await this.sendMessage(
      notification.chatId,
      lines.join('\n'),
      sink,
      reminderKeyboard(notification.id),
    );
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

    // The notification id, the action, and the sender - never the reminder's contents.
    this.logger.log(
      `Received callback ${tap?.action ?? 'unparseable'} from ${sender} for notification ${tap?.id ?? 'none'}`,
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
      // Owner check. A notification belonging to somebody else - or one that no longer exists - is
      // refused with no state change at all.
      const owned = await this.reminders.getOwnedNotification(query.from.id, tap.id);
      if (!owned) {
        this.logger.warn(`Refused callback from ${sender}: notification ${tap.id} is not theirs`);
        await this.answerCallback(query.id, 'That reminder is not yours.', sink);
        return;
      }

      await this.applyCallback(owned, query, now, tap.action, sink);
    } catch (error) {
      this.logger.error(`Failed to apply callback for notification ${tap.id}`, error as Error);
      await this.answerCallback(query.id, 'Sorry, that did not go through.', sink);
    }
  }

  /**
   * The three button branches, each acting on **one** notification. A snooze moves that
   * notification's own time only: `eventAt` is never touched, and the reminder's other
   * notifications stay exactly where they are.
   */
  private async applyCallback(
    owned: OwnedNotification,
    query: TelegramCallbackQuery,
    now: Date,
    action: ReminderAction,
    sink?: string[],
  ): Promise<void> {
    const userId = query.from.id;
    const timezone = this.classifier.defaultTimezone;

    if (action === 'ok') {
      await this.reminders.ackNotification(owned.ref, userId, now);
      await this.answerCallback(query.id, 'Готово.', sink);
      // Best effort: the notification is already acked, so a failure here is cosmetic.
      await this.removeKeyboard(query.message);
      return;
    }

    const at =
      action === '1h'
        ? this.clock.plusHours(now, 1)
        : this.clock.nextDayAt(now, timezone, SNOOZE_TOMORROW_HOUR);
    const atLocal = this.clock.formatLocal(at, timezone);

    await this.reminders.snoozeNotification(owned.ref, userId, at, atLocal, owned.recurring);
    await this.answerCallback(
      query.id,
      `Нагадаю ще раз ${humanizeInstant(atLocal, now, { capitalize: false })}.`,
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
   * Dumps the requesting user's stored reminders, actors, notes and symptoms as one JSON object
   * `{"reminders":[...],"actors":[...],"notes":[...],"symptoms":[...]}`. Read back by the verifier
   * over HTTP; assertions are made on this structure, never on reply wording. The output embeds the
   * user's own words, the names of real people and health information, so it is never logged - only
   * its item counts are.
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

    let actors: Awaited<ReturnType<ActorsService['list']>> = [];
    if (from && this.actors.available) {
      try {
        actors = await this.actors.list(from.id);
      } catch (error) {
        this.logger.error(`Failed to export actors for ${sender}`, error as Error);
      }
    }

    let notes: Awaited<ReturnType<NotesService['list']>> = [];
    if (from && this.notes.available) {
      try {
        notes = await this.notes.list(from.id);
      } catch (error) {
        this.logger.error(`Failed to export notes for ${sender}`, error as Error);
      }
    }

    let symptoms: Awaited<ReturnType<SymptomsService['list']>> = [];
    if (from && this.symptoms.available) {
      try {
        symptoms = await this.symptoms.list(from.id);
      } catch (error) {
        this.logger.error(`Failed to export symptoms for ${sender}`, error as Error);
      }
    }

    this.logger.log(
      `Exported ${reminders.length} reminder(s), ${actors.length} actor(s), ${notes.length} note(s) and ${symptoms.length} symptom(s) for ${sender}`,
    );
    await this.sendMessage(chatId, JSON.stringify({ reminders, actors, notes, symptoms }), sink);
  }

  private async handleVoice(
    message: TelegramMessage,
    voice: TelegramVoice,
    sender: string,
    now: Date,
    sink?: string[],
    actorAsks?: ActorQuestion[],
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
    await this.route(
      chatId,
      transcript,
      message.from,
      sender,
      now,
      `"${transcript}"`,
      sink,
      message.message_id,
      actorAsks,
    );
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
    messageId?: number,
    actorAsks?: ActorQuestion[],
  ): Promise<void> {
    if (!this.classifier.available) {
      this.logger.warn(`Cannot classify for ${sender}: classifier is not configured`);
      await this.sendMessage(chatId, [prefix, text].filter(Boolean).join('\n\n'), sink);
      return;
    }

    const timezone = this.classifier.defaultTimezone;
    // Who this user already knows, and what they already said is not a person: both are handed to
    // the model so it does not raise the same name twice. The app-level check in `resolve` is what
    // actually enforces it - this only saves the model from proposing something pointless.
    const { knownActors, declinedMentions } = await this.actorContext(from, sender);
    // The slugs this user has already used, so "my head hurts" reuses `headache` rather than the
    // model minting a new slug each wording - the observable guarantee behind aggregating symptoms
    // later. Read as part of building the context, so it runs after the allowlist gate; a read
    // failure must never block classification.
    const knownSymptomTypes = await this.symptomTypes(from, sender);
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
        knownSymptomTypes,
        knownActors,
        declinedMentions,
        // previousText is the only way a correction can be recognised; still absent until stored.
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
    // Whether the message produced a reminder at all. The ask flow hangs off that intent alone,
    // because a reminder is the only thing actually stored for a mention to belong to - and it
    // hangs off the intent, not off a successful store, since an unresolved time says nothing
    // about whether the person is new.
    const hasReminder = result.items.some((item) => item.intent === 'reminder');
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

      if (item.intent === 'note' || item.intent === 'other') {
        const outcome = await this.handleNote(item, from, chatId, text, now, sender, result);
        lines.push(outcome.text);
        if (!outcome.stored) {
          hasUnstored = true;
        }
        continue;
      }

      if (item.intent === 'symptom') {
        const outcome = await this.handleSymptom(item, from, chatId, text, now, sender);
        lines.push(outcome.text);
        if (!outcome.stored) {
          hasUnstored = true;
        }
        continue;
      }

      hasUnstored = true;
      lines.push(this.describeItem(item, result, now));
    }

    if (needsClarification) {
      lines.push('', 'Which is it - a note, a reminder, a symptom, or a question?');
    }

    if (hasUnstored) {
      lines.push('', NOT_STORED_NOTICE);
    }
    await this.sendMessage(chatId, lines.join('\n'), sink);

    // Strictly after the reminder's own reply: asking about a person is a follow-up, and a failure
    // in it must never delay or replace the confirmation the user is waiting for.
    if (hasReminder && from && messageId !== undefined) {
      await this.askAboutNewMention(
        chatId,
        messageId,
        from.id,
        result.mentions,
        now,
        sender,
        sink,
        actorAsks,
      );
    }
  }

  /** Known people and declined mentions for the classifier prompt; empty if they cannot be read. */
  private async actorContext(
    from: TelegramUser | undefined,
    sender: string,
  ): Promise<{ knownActors: { name: string; aliases: string[] }[]; declinedMentions: string[] }> {
    if (!from || !this.actors.available) {
      return { knownActors: [], declinedMentions: [] };
    }

    try {
      const [knownActors, declinedMentions] = await Promise.all([
        this.actors.listKnown(from.id),
        this.actors.listDeclined(from.id),
      ]);
      return { knownActors, declinedMentions };
    } catch (error) {
      // Degrade to no context rather than failing the message: the worst case is one extra question.
      this.logger.error(`Failed to read actor context for ${sender}`, error as Error);
      return { knownActors: [], declinedMentions: [] };
    }
  }

  /** This user's known symptom slugs for the classifier prompt; empty if they cannot be read. */
  private async symptomTypes(from: TelegramUser | undefined, sender: string): Promise<string[]> {
    if (!from || !this.symptoms.available) {
      return [];
    }

    try {
      return await this.symptoms.listKnownTypes(from.id);
    } catch (error) {
      // Degrade to no vocabulary rather than blocking the classifier call: the worst case is the
      // model minting a fresh slug for a wording it could have reused.
      this.logger.error(`Failed to read symptom vocabulary for ${sender}`, error as Error);
      return [];
    }
  }

  /**
   * Asks about the first mention this user neither knows nor has declined - at most one question
   * per message, however many new names it carried. The question is sent as a native Telegram reply
   * to the user's *own* message, so the answer arrives with a `reply_to_message` the pending
   * question can be matched by, and the open question is recorded in Firestore rather than in
   * memory: the instance that asks is not necessarily the one that reads the answer.
   *
   * Everything here is best effort. A failure is logged and dropped, never surfaced - the reminder
   * has already been confirmed by this point.
   */
  private async askAboutNewMention(
    chatId: number,
    messageId: number,
    userId: number,
    mentions: string[],
    now: Date,
    sender: string,
    sink?: string[],
    actorAsks?: ActorQuestion[],
  ): Promise<void> {
    if (!this.actors.available || mentions.length === 0) {
      return;
    }

    try {
      const mention = await firstNewMention(mentions, (candidate) =>
        this.actors.resolve(userId, candidate),
      );
      if (!mention) {
        return;
      }

      const questionMessageId = await this.sendMessage(
        chatId,
        `I do not know ${mention} yet. Who is that? Tell me anything worth remembering, or say "no" and I will stop asking.`,
        sink,
        undefined,
        messageId,
      );
      if (questionMessageId === undefined) {
        return;
      }

      await this.actors.setPendingQuestion(userId, chatId, { mention, questionMessageId }, now);
      // Reflect mode only: the test function's response carries the question so a test can reply
      // to it. The mention is never logged, only returned to the sender who just said it.
      actorAsks?.push({ mention, questionMessageId });
    } catch (error) {
      this.logger.error(`Failed to ask about a new mention for ${sender}`, error as Error);
    }
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
      return { text: this.describeReminder(item, now), stored: false };
    }

    if (!from || !this.reminders.available) {
      return {
        text: `${this.describeReminder(item, now)}\nНе вдалося зберегти це нагадування зараз.`,
        stored: false,
      };
    }

    try {
      const id = await this.reminders.create(
        from.id,
        chatId,
        {
          title: reminder.title,
          eventAt: reminder.eventAt,
          notifyAt: reminder.notifyAt,
          recurrence: reminder.recurrence,
        },
        originalText,
        now,
      );
      if (!id) {
        return {
          text: `${this.describeReminder(item, now)}\nНе зрозумів точний час, тому не зберіг.`,
          stored: false,
        };
      }

      // A recurring reminder has no eventAt of its own - the time confirmed back is the occurrence
      // that was just armed, recomputed from the same rule and the same "now" the store used.
      const resolved = reminder.recurrence
        ? (nextOccurrence(reminder.recurrence, now) ?? '')
        : (normalizeEventAt(reminder.eventAt, now) ?? reminder.eventAt ?? '');
      const lines = [`Нагадування збережено: ${reminder.title}`, humanizeInstant(resolved, now)];
      if (reminder.recurrence) {
        lines.push(`Повторюється: ${describeRecurrence(reminder.recurrence)}`);
      }
      return { text: lines.join('\n'), stored: true };
    } catch (error) {
      this.logger.error(`Failed to store reminder for ${sender}`, error as Error);
      return {
        text: `${this.describeReminder(item, now)}\nНе вдалося зберегти це нагадування зараз.`,
        stored: false,
      };
    }
  }

  /**
   * The note branch: persist a stray thought (`note`) or an off-topic message (`other`), keeping
   * the classified intent distinct, and confirm it. The item is already at or above CONFIDENCE_ASK
   * here. Unlike a reminder there is nothing to validate away - the summary is the classifier's own
   * words about text that already exists - so the only reason not to store is the store being
   * unavailable, and a `create` failure is logged, never thrown up to the webhook.
   */
  private async handleNote(
    item: Classification,
    from: TelegramUser | undefined,
    chatId: number,
    originalText: string,
    now: Date,
    sender: string,
    result: ClassificationResult,
  ): Promise<{ text: string; stored: boolean }> {
    const intent = item.intent === 'other' ? 'other' : 'note';

    if (from && this.notes.available) {
      try {
        const id = await this.notes.create(from.id, chatId, originalText, item.summary, intent, now);
        if (id) {
          const body =
            intent === 'other'
              ? `Not sure what that was, so I kept it as a note: ${item.summary}`
              : `Note saved: ${item.summary}`;
          return { text: this.withConfidence(body, item), stored: true };
        }
      } catch (error) {
        this.logger.error(`Failed to store note for ${sender}`, error as Error);
      }
    }

    // No user, store unavailable, or a create failure: fall back to the preview wording (which reads
    // correctly as a preview, not a confirmation) and say plainly it was not kept.
    return {
      text: `${this.describeItem(item, result, now)}\nI could not store this note right now.`,
      stored: false,
    };
  }

  /**
   * The symptom branch: persist a reported health event and confirm it, or explain why it could not
   * be stored. The item is already at or above CONFIDENCE_ASK here, which - given the classifier's
   * validation - means it carries a non-empty `type` (a typeless symptom was forced below the
   * threshold). Unlike a reminder there is nothing to validate away: `type` is present and every
   * other field is optional, so the only reason not to store is the store being unavailable, and a
   * `create` failure is logged, never thrown up to the webhook.
   *
   * Nothing about the symptom is logged - it is health information; only the id and the store
   * outcome are.
   */
  private async handleSymptom(
    item: Classification,
    from: TelegramUser | undefined,
    chatId: number,
    originalText: string,
    now: Date,
    sender: string,
  ): Promise<{ text: string; stored: boolean }> {
    const symptom = item.symptom;

    if (from && this.symptoms.available && symptom) {
      try {
        const id = await this.symptoms.create(
          from.id,
          chatId,
          {
            type: symptom.type,
            severity: symptom.severity,
            startedAt: symptom.startedAt,
            durationMinutes: symptom.durationMinutes,
            notes: symptom.notes,
          },
          originalText,
          now,
        );
        if (id) {
          // Reuse the preview block, re-prefixed to read as a confirmation. describeSymptom already
          // wraps it in withConfidence, so the middle band still shows its number; the `^` anchor
          // only re-labels the first line and leaves any trailing confidence line intact.
          return {
            text: this.describeSymptom(item).replace(/^Symptom:/, 'Logged symptom:'),
            stored: true,
          };
        }
      } catch (error) {
        this.logger.error(`Failed to store symptom for ${sender}`, error as Error);
      }
    }

    // No user, store unavailable, missing payload, or a create failure: fall back to the preview
    // and say plainly it was not kept, matching handleReminder's degrade wording.
    return {
      text: `${this.describeSymptom(item)}\nI could not store this symptom right now.`,
      stored: false,
    };
  }

  /**
   * One branch per intent. Each of these becomes a write once Firestore exists; for now the
   * branch is where the reply is composed, so the routing itself is observable.
   */
  private describeItem(item: Classification, result: ClassificationResult, now: Date): string {
    switch (item.intent) {
      case 'reminder':
        return this.describeReminder(item, now);
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

  private describeReminder(item: Classification, now: Date): string {
    const reminder = item.reminder;
    if (!reminder) {
      return this.withConfidence(`Нагадування: ${item.summary}`, item);
    }

    const details: string[] = [`Нагадування: ${reminder.title}`];
    details.push(reminder.eventAt ? humanizeInstant(reminder.eventAt, now) : 'Час не вказано');
    details.push(
      reminder.leadMinutes === undefined
        ? 'Час попередження не вказано, я перепитаю'
        : `Нагадати за ${reminder.leadMinutes} хв до події`,
    );
    if (reminder.recurrence) {
      details.push(`Повторюється: ${describeRecurrence(reminder.recurrence)}`);
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

  /**
   * Sends one reply, split into as many Telegram messages as its length needs, and returns the id
   * of the last one - which is what the actor question is later matched by. `replyToMessageId`
   * makes every chunk a native Telegram reply to that message. Existing callers ignore the return
   * value and pass neither extra argument, so their behaviour is unchanged.
   */
  private async sendMessage(
    chatId: number,
    text: string,
    sink?: string[],
    replyMarkup?: InlineKeyboardMarkup,
    replyToMessageId?: number,
  ): Promise<number | undefined> {
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

    let messageId: number | undefined;
    for (const [index, chunk] of chunks.entries()) {
      try {
        // The keyboard goes on the last chunk so the buttons sit under the whole message.
        const markup = replyMarkup && index === chunks.length - 1 ? replyMarkup : undefined;
        const { data } = await this.api.post<TelegramApiResponse<TelegramMessage>>('/sendMessage', {
          chat_id: chatId,
          text: chunk,
          ...(markup ? { reply_markup: markup } : {}),
          ...(replyToMessageId !== undefined ? { reply_to_message_id: replyToMessageId } : {}),
        });
        const sent = data?.result?.message_id;
        // A placeholder when Telegram answered without one, so a caller that needs an id to key on
        // always gets one.
        messageId = typeof sent === 'number' ? sent : syntheticMessageId();
      } catch (error) {
        if (!sink) {
          throw error;
        }
        this.logger.warn(
          `reflect: sendMessage to chat ${chatId} failed: ${(error as Error).message}`,
        );
        // Reflect mode only: the send failed because the chat id is a throwaway, so there is no
        // real id to return. A local one keeps the pending-question flow deterministic under test.
        messageId = syntheticMessageId();
      }
    }

    return messageId;
  }
}
