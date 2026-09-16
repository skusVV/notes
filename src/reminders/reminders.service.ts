import { DocumentData, Timestamp } from '@google-cloud/firestore';
import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { FirestoreService } from '../firestore/firestore.service';
import { computeExpireAt, normalizeEventAt } from './event-at';

/** The part of a classified reminder the store needs; the rest of the draft is not persisted yet. */
export interface ReminderDraftInput {
  title: string;
  eventAt?: string;
}

/** The `/export` shape for one reminder. Timestamps are rendered as strings for a JSON reader. */
export interface ReminderExport {
  id: string;
  originalText: string;
  title: string;
  eventAt: string;
  remindAt: string;
  createdAt: string;
  expireAt: string;
  status: string;
}

/**
 * Persists reminders at `users/{userId}/reminders/{autoId}` and reads them back. Degrades with the
 * Firestore provider: when the store is unavailable, `create` reports it could not write and `list`
 * returns nothing, so text handling survives an unconfigured project (same pattern as the model
 * services).
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(private readonly firestore: FirestoreService) {}

  get available(): boolean {
    return this.firestore.available;
  }

  /**
   * Validates and normalises `eventAt`, then writes one reminder. Returns the new document id, or
   * `undefined` when the store is unavailable or the time is not a resolvable future instant (no
   * write) - the caller then treats the reminder as unresolved and does not claim a store.
   */
  async create(
    userId: number,
    chatId: number,
    draft: ReminderDraftInput,
    originalText: string,
    now: Date,
  ): Promise<string | undefined> {
    const db = this.firestore.db;
    if (!db) {
      return undefined;
    }

    const eventAt = normalizeEventAt(draft.eventAt, now);
    if (!eventAt) {
      return undefined;
    }

    const eventInstant = DateTime.fromISO(eventAt, { setZone: true }).toJSDate();
    const eventAtUtc = Timestamp.fromDate(eventInstant);
    const document: DocumentData = {
      userId,
      chatId,
      originalText,
      title: draft.title,
      eventAt,
      eventAtUtc,
      // remindAt starts equal to the event instant; it is kept separate so a later snooze can move
      // the notification without moving the event. Delivery (spec 0003) compares against it.
      remindAt: eventAtUtc,
      createdAt: Timestamp.fromDate(now),
      // The field the Firestore TTL policy targets, so an expired reminder is reaped automatically.
      expireAt: Timestamp.fromDate(computeExpireAt(eventAt)),
      status: 'scheduled',
    };

    const ref = await db.collection('users').doc(String(userId)).collection('reminders').add(document);
    // Log the id and user, never the reminder content - these are the user's private notes.
    this.logger.log(`Stored reminder ${ref.id} for user ${userId}`);
    return ref.id;
  }

  /** That user's reminders, ordered by `eventAt` ascending. Empty when the store is unavailable. */
  async list(userId: number): Promise<ReminderExport[]> {
    const db = this.firestore.db;
    if (!db) {
      return [];
    }

    const snapshot = await db
      .collection('users')
      .doc(String(userId))
      .collection('reminders')
      .orderBy('eventAt', 'asc')
      .get();

    return snapshot.docs.map((doc) => this.toExport(doc.id, doc.data()));
  }

  private toExport(id: string, data: DocumentData): ReminderExport {
    const eventAt = typeof data.eventAt === 'string' ? data.eventAt : '';
    return {
      id,
      originalText: typeof data.originalText === 'string' ? data.originalText : '',
      title: typeof data.title === 'string' ? data.title : '',
      eventAt,
      // remindAt is emitted in the same local-ISO-with-offset form as eventAt. It starts equal to
      // the event instant, so render it in the zone the eventAt string carries.
      remindAt: this.remindAtLocal(data.remindAt, eventAt),
      createdAt: toIso(data.createdAt),
      expireAt: toIso(data.expireAt),
      status: typeof data.status === 'string' ? data.status : '',
    };
  }

  private remindAtLocal(value: unknown, eventAt: string): string {
    if (!(value instanceof Timestamp)) {
      return '';
    }
    const zone = DateTime.fromISO(eventAt, { setZone: true }).zone;
    const local = DateTime.fromJSDate(value.toDate(), { zone });
    return local.toISO({ suppressMilliseconds: true, includeOffset: true }) ?? '';
  }
}

/** Serialise a Firestore Timestamp as a plain ISO string; anything else becomes empty. */
function toIso(value: unknown): string {
  return value instanceof Timestamp ? value.toDate().toISOString() : '';
}
