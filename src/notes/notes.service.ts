import { DocumentData, Timestamp } from '@google-cloud/firestore';
import { Injectable, Logger } from '@nestjs/common';
import { Intent } from '../classifier/classifier.types';
import { FirestoreService } from '../firestore/firestore.service';

/** The subcollection holding one document per stray thought the user chose to keep. */
export const NOTES = 'notes';

/**
 * The `/export` shape for one note. `createdAt` is serialised as an ISO string, same convention as
 * `ReminderExport` and `ActorExport`.
 */
export interface NoteExport {
  id: string;
  originalText: string;
  summary: string;
  intent: Intent;
  createdAt: string;
}

/**
 * Persists notes at `users/{userId}/notes/{autoId}` and reads them back. Degrades with the Firestore
 * provider exactly as `RemindersService` and `ActorsService` do: with no project configured
 * `available` is false, `create` writes nothing and reports it, and `list` returns nothing, so text
 * handling survives an unconfigured store.
 *
 * A note is the bot's memory, not a queue: unlike reminders it carries no TTL and no `expireAt`, so
 * nothing reaps it - it is meant to be kept indefinitely.
 *
 * Nothing here is ever logged beyond ids and counts: a note's `originalText` and `summary` are the
 * user's own private words.
 */
@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(private readonly firestore: FirestoreService) {}

  get available(): boolean {
    return this.firestore.available;
  }

  /**
   * Writes one note at `users/{userId}/notes/{autoId}`. `intent` is the literal classified value,
   * `'note'` or `'other'` - kept distinct rather than collapsed, because the `other` rate is itself
   * a signal the taxonomy needs a new intent. Returns the new document's id, or `undefined` when the
   * store is unavailable (no write attempted). There is no rejection path for a well-formed note:
   * the summary is the classifier's own words about text that already exists, so nothing is invented
   * or validated away.
   */
  async create(
    userId: number,
    chatId: number,
    originalText: string,
    summary: string,
    intent: 'note' | 'other',
    now: Date,
  ): Promise<string | undefined> {
    const db = this.firestore.db;
    if (!db) {
      return undefined;
    }

    const document: DocumentData = {
      userId,
      chatId,
      originalText,
      summary,
      intent,
      createdAt: Timestamp.fromDate(now),
    };

    const ref = db.collection('users').doc(String(userId)).collection(NOTES).doc();
    await ref.set(document);

    // Log the id, the user and the intent, never the note content - these are private notes.
    this.logger.log(`Stored ${intent} note ${ref.id} for user ${userId}`);
    return ref.id;
  }

  /**
   * That user's notes, ordered by `createdAt` ascending. Empty when the store is unavailable.
   */
  async list(userId: number): Promise<NoteExport[]> {
    const db = this.firestore.db;
    if (!db) {
      return [];
    }

    const snapshot = await db
      .collection('users')
      .doc(String(userId))
      .collection(NOTES)
      .orderBy('createdAt', 'asc')
      .get();

    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        originalText: readString(data.originalText),
        summary: readString(data.summary),
        intent: data.intent === 'other' ? 'other' : 'note',
        createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : '',
      };
    });
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
