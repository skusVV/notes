import { DocumentData, Timestamp } from '@google-cloud/firestore';
import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../firestore/firestore.service';

/** The subcollection holding one document per health event the user reported. */
export const SYMPTOMS = 'symptoms';

/**
 * The part of a classified symptom the store needs. The classifier already extracts these fields
 * and defends them (severity clamped, a typeless symptom forced below the ask-threshold), so this
 * carries them through unchanged. Every field but `type` is optional, and absence is meaningful:
 * "not stated" is a real state that must survive the round trip, so an absent field is never
 * defaulted to a number, `null`, or an empty string on write.
 */
export interface SymptomDraftInput {
  type: string;
  severity?: number;
  startedAt?: string;
  durationMinutes?: number;
  notes?: string;
}

/**
 * The `/export` shape for one symptom. `createdAt` is serialised as an ISO string, same convention
 * as `ReminderExport`, `ActorExport` and `NoteExport`. The optional fields become an explicit
 * `null` (or `''` for `notes`) so a reader can tell "not stated" from a value that failed to render.
 */
export interface SymptomExport {
  id: string;
  originalText: string;
  type: string;
  /** `null` when absent - never inferred, so a reader can tell "not stated" from a real value. */
  severity: number | null;
  /** The classifier's ISO-8601-with-offset string, or `null` when absent. */
  startedAt: string | null;
  durationMinutes: number | null;
  /** The user's own free-text description, or `''` when absent. */
  notes: string;
  createdAt: string;
}

/**
 * Persists symptoms at `users/{userId}/symptoms/{autoId}` and reads them back. Degrades with the
 * Firestore provider exactly as `RemindersService`, `ActorsService` and `NotesService` do: with no
 * project configured `available` is false, `create` writes nothing and reports it, and the reads
 * return nothing, so text handling survives an unconfigured store.
 *
 * A symptom is the signal layer's raw material, not a queue: like a note and unlike a reminder it
 * carries no TTL and no `expireAt`, so nothing reaps it - it is kept indefinitely so a later feature
 * can notice a tendency across many entries.
 *
 * Symptoms are health information. Nothing here is ever logged beyond ids and counts - never a
 * `type`, `severity`, `startedAt`, `notes`, or `originalText`.
 */
@Injectable()
export class SymptomsService {
  private readonly logger = new Logger(SymptomsService.name);

  constructor(private readonly firestore: FirestoreService) {}

  get available(): boolean {
    return this.firestore.available;
  }

  /**
   * Writes one symptom at `users/{userId}/symptoms/{autoId}`. Returns the new document's id, or
   * `undefined` when the store is unavailable (no write attempted). There is no rejection path for a
   * well-formed symptom: a typeless symptom never reaches here (the classifier forced it below
   * `CONFIDENCE_ASK`), and every other field is optional, so nothing is validated away.
   *
   * Absent stays absent: `severity`, `startedAt`, `durationMinutes` and `notes` are written only
   * when the draft carries them, so a missing field is never persisted as `0`, `null`, or `''` -
   * absence is the meaningful state.
   */
  async create(
    userId: number,
    chatId: number,
    draft: SymptomDraftInput,
    originalText: string,
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
      type: draft.type,
      createdAt: Timestamp.fromDate(now),
      ...(draft.severity !== undefined ? { severity: draft.severity } : {}),
      ...(draft.startedAt !== undefined ? { startedAt: draft.startedAt } : {}),
      ...(draft.durationMinutes !== undefined ? { durationMinutes: draft.durationMinutes } : {}),
      ...(draft.notes !== undefined ? { notes: draft.notes } : {}),
    };

    const ref = db.collection('users').doc(String(userId)).collection(SYMPTOMS).doc();
    await ref.set(document);

    // Log the id and the user, never the symptom content - this is health information.
    this.logger.log(`Stored symptom ${ref.id} for user ${userId}`);
    return ref.id;
  }

  /**
   * That user's symptoms, ordered by `createdAt` ascending (`createdAt` is always present;
   * `startedAt` may not be, so it is not the sort key). Empty when the store is unavailable.
   */
  async list(userId: number): Promise<SymptomExport[]> {
    const db = this.firestore.db;
    if (!db) {
      return [];
    }

    const snapshot = await db
      .collection('users')
      .doc(String(userId))
      .collection(SYMPTOMS)
      .orderBy('createdAt', 'asc')
      .get();

    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        originalText: readString(data.originalText),
        type: readString(data.type),
        severity: typeof data.severity === 'number' ? data.severity : null,
        startedAt: typeof data.startedAt === 'string' ? data.startedAt : null,
        durationMinutes: typeof data.durationMinutes === 'number' ? data.durationMinutes : null,
        notes: readString(data.notes),
        createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : '',
      };
    });
  }

  /**
   * The distinct `type` slugs this user has stored, for `ClassifierContext.knownSymptomTypes`. This
   * is the read that stops the model minting a new slug for every wording, which is what makes
   * counting the same symptom across wordings possible at all. Empty when the store is unavailable.
   */
  async listKnownTypes(userId: number): Promise<string[]> {
    const db = this.firestore.db;
    if (!db) {
      return [];
    }

    const snapshot = await db
      .collection('users')
      .doc(String(userId))
      .collection(SYMPTOMS)
      .get();

    const types = new Set<string>();
    for (const doc of snapshot.docs) {
      const type = readString(doc.data().type);
      if (type) {
        types.add(type);
      }
    }
    return [...types];
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
