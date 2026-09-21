import { DocumentData, FieldValue, Timestamp } from '@google-cloud/firestore';
import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../firestore/firestore.service';

/** The subcollection holding one document per person the user chose to remember. */
export const ACTORS = 'actors';

/** The subcollection holding the one open question per chat. Also the TTL policy's target. */
export const PENDING = 'pending';

/** An unanswered question is forgotten after a day rather than waiting forever. */
export const PENDING_EXPIRY_HOURS = 24;

/**
 * What a mention resolves to. `new` is the only outcome that may produce a question - the other two
 * both mean "already settled, do not ask again".
 */
export type ActorResolution = 'known' | 'declined' | 'new';

/** The `/export` shape for one actor. `createdAt` is a string, same convention as reminders. */
export interface ActorExport {
  id: string;
  name: string;
  aliases: string[];
  notes: string;
  createdAt: string;
}

/** The open "who is this?" question for one chat. */
export interface PendingQuestion {
  mention: string;
  questionMessageId: number;
}

/** What the user says to mean "that is not a person worth tracking". */
const DECLINE_PHRASES = new Set([
  'no',
  'nope',
  'ні',
  'нет',
  'не',
  'not a person',
  'не людина',
]);

/**
 * The comparison form for a mention: trimmed and lowercased. Case is the only variation folded
 * away here - a grammatical case ("Антона" vs "Антон") is normalised by the classifier instead,
 * because only the model knows the language.
 */
export function normalizeMention(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Whether a reply to the actor question means "no". Exact matches only, against the closed list
 * above: anything else is treated as information about the person, so a real answer is never
 * thrown away by a fuzzy match. One trailing `.`/`!`/`?` is stripped, because "ні." is still "ні".
 */
export function isDeclineReply(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?]$/, '').trim();
  return DECLINE_PHRASES.has(normalized);
}

/**
 * The first mention that is neither a known actor nor a previously declined one, or `undefined`
 * when every mention is already settled. At most one question is ever asked per message, so this
 * stops at the first candidate rather than collecting them all. Duplicates within one message are
 * resolved once.
 *
 * `resolve` is injected rather than called on the service directly so the selection rule can be
 * unit tested without a store.
 */
export async function firstNewMention(
  mentions: string[],
  resolve: (mention: string) => Promise<ActorResolution>,
): Promise<string | undefined> {
  const seen = new Set<string>();

  for (const raw of mentions) {
    const mention = raw.trim();
    const key = normalizeMention(mention);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);

    if ((await resolve(mention)) === 'new') {
      return mention;
    }
  }

  return undefined;
}

/**
 * The people the user has chosen to remember, at `users/{userId}/actors/{autoId}`, plus the
 * mentions they declined (an array on the user document) and the one open question per chat at
 * `users/{userId}/pending/{chatId}`.
 *
 * Degrades with the Firestore provider exactly as `RemindersService` does: with no project
 * configured nothing is stored, `resolve` reports every mention as already settled so the bot never
 * asks a question it could not remember asking, and message handling carries on unchanged.
 *
 * Nothing here is ever logged beyond ids and counts: an actor's name and notes are the user's own
 * words about a real person.
 */
@Injectable()
export class ActorsService {
  private readonly logger = new Logger(ActorsService.name);

  constructor(private readonly firestore: FirestoreService) {}

  get available(): boolean {
    return this.firestore.available;
  }

  /** Known people, for `ClassifierContext.knownActors`. Empty when the store is unavailable. */
  async listKnown(userId: number): Promise<{ name: string; aliases: string[] }[]> {
    const snapshot = await this.actorDocs(userId);
    return snapshot
      .map((data) => ({ name: readString(data.name), aliases: readStrings(data.aliases) }))
      .filter((actor) => actor.name !== '');
  }

  /** Declined mentions, for `ClassifierContext.declinedMentions`. Already normalised on write. */
  async listDeclined(userId: number): Promise<string[]> {
    const db = this.firestore.db;
    if (!db) {
      return [];
    }

    const snapshot = await db.collection('users').doc(String(userId)).get();
    return readStrings(snapshot.data()?.declinedMentions);
  }

  /**
   * The app-level backstop behind the prompt: whether this mention is somebody already known, a
   * mention already declined, or somebody new. Correctness of "do not ask twice" never depends on
   * the model obeying its instructions, only on this comparison.
   */
  async resolve(userId: number, mention: string): Promise<ActorResolution> {
    if (!this.firestore.db) {
      // With no store there is nowhere to record an answer, so nothing counts as new.
      return 'declined';
    }

    const needle = normalizeMention(mention);
    if (!needle) {
      return 'declined';
    }

    const declined = await this.listDeclined(userId);
    if (declined.some((entry) => normalizeMention(entry) === needle)) {
      return 'declined';
    }

    const known = await this.listKnown(userId);
    const matches = (actor: { name: string; aliases: string[] }): boolean =>
      [actor.name, ...actor.aliases].some((form) => normalizeMention(form) === needle);
    return known.some(matches) ? 'known' : 'new';
  }

  /**
   * Stores one person as the user described them. `notes` is whatever they replied, kept verbatim -
   * no relation, no birthday, no extra aliases: this spec gathers information, it does not label it.
   */
  async create(
    userId: number,
    actor: { name: string; notes: string },
    now: Date,
  ): Promise<void> {
    const db = this.firestore.db;
    if (!db) {
      return;
    }

    const ref = db.collection('users').doc(String(userId)).collection(ACTORS).doc();
    await ref.set({
      name: actor.name,
      // The name itself is the first alias, so a later mention in any wording the classifier
      // normalises to it resolves without a second question.
      aliases: [actor.name],
      notes: actor.notes,
      createdAt: Timestamp.fromDate(now),
    });

    this.logger.log(`Stored actor ${ref.id} for user ${userId}`);
  }

  /**
   * Records that a mention is not a person worth tracking. It lives on the user document rather
   * than on an actor, because a declined mention has no actor to hang off.
   */
  async decline(userId: number, mention: string): Promise<void> {
    const db = this.firestore.db;
    const value = normalizeMention(mention);
    if (!db || !value) {
      return;
    }

    // Merge + arrayUnion so the user document need not exist yet and a repeat decline is a no-op.
    await db
      .collection('users')
      .doc(String(userId))
      .set({ declinedMentions: FieldValue.arrayUnion(value) }, { merge: true });

    this.logger.log(`Recorded a declined mention for user ${userId}`);
  }

  /** That user's actors for `/export`, oldest first. Empty when the store is unavailable. */
  async list(userId: number): Promise<ActorExport[]> {
    const db = this.firestore.db;
    if (!db) {
      return [];
    }

    const snapshot = await db
      .collection('users')
      .doc(String(userId))
      .collection(ACTORS)
      .orderBy('createdAt', 'asc')
      .get();

    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: readString(data.name),
        aliases: readStrings(data.aliases),
        notes: readString(data.notes),
        createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : '',
      };
    });
  }

  /**
   * The open question for this chat, or `undefined` when there is none or it has expired. The
   * expiry is checked here as well as by the TTL policy: Firestore reaps expired documents within
   * about a day, so a question must stop being answerable on time rather than on deletion.
   */
  async getPendingQuestion(
    userId: number,
    chatId: number,
    now: Date,
  ): Promise<PendingQuestion | undefined> {
    const db = this.firestore.db;
    if (!db) {
      return undefined;
    }

    const snapshot = await db
      .collection('users')
      .doc(String(userId))
      .collection(PENDING)
      .doc(String(chatId))
      .get();
    const data = snapshot.data();
    if (!data || data.kind !== 'actor_confirm') {
      return undefined;
    }

    const expiresAt = data.expiresAt instanceof Timestamp ? data.expiresAt.toDate() : undefined;
    if (expiresAt && expiresAt.getTime() <= now.getTime()) {
      return undefined;
    }

    const mention = readString(data.mention);
    const questionMessageId = data.questionMessageId;
    if (!mention || typeof questionMessageId !== 'number') {
      return undefined;
    }

    return { mention, questionMessageId };
  }

  /**
   * Opens the question for this chat. One slot per chat, so a new question overwrites an
   * unanswered one - "at most one question per message" would otherwise leave a queue of stale
   * questions nobody will answer.
   */
  async setPendingQuestion(
    userId: number,
    chatId: number,
    question: PendingQuestion,
    now: Date,
  ): Promise<void> {
    const db = this.firestore.db;
    if (!db) {
      return;
    }

    await db
      .collection('users')
      .doc(String(userId))
      .collection(PENDING)
      .doc(String(chatId))
      .set({
        kind: 'actor_confirm',
        mention: question.mention,
        questionMessageId: question.questionMessageId,
        createdAt: Timestamp.fromDate(now),
        // The field the TTL policy targets: an unanswered question disappears on its own.
        expiresAt: Timestamp.fromMillis(now.getTime() + PENDING_EXPIRY_HOURS * 3_600_000),
      });

    this.logger.log(`Opened an actor question for user ${userId} in chat ${chatId}`);
  }

  /** Closes the question for this chat, answered or not. */
  async clearPendingQuestion(userId: number, chatId: number): Promise<void> {
    const db = this.firestore.db;
    if (!db) {
      return;
    }

    await db
      .collection('users')
      .doc(String(userId))
      .collection(PENDING)
      .doc(String(chatId))
      .delete();
  }

  private async actorDocs(userId: number): Promise<DocumentData[]> {
    const db = this.firestore.db;
    if (!db) {
      return [];
    }

    const snapshot = await db.collection('users').doc(String(userId)).collection(ACTORS).get();
    return snapshot.docs.map((doc) => doc.data());
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}
