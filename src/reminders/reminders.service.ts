import { DocumentData, DocumentReference, Timestamp } from '@google-cloud/firestore';
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
 * A reminder the sweep found due. Carries the document reference so the claim transaction can
 * re-read exactly this document, plus only the fields a delivery needs.
 */
export interface DueReminder {
  id: string;
  ref: DocumentReference;
  userId: number;
  chatId: number;
  title: string;
  eventAt: string;
}

/** A reminder loaded for an owner check, before a callback acts on it. */
export interface OwnedReminder {
  id: string;
  userId: number;
  status: string;
  title: string;
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

  /**
   * Every user's reminders that are still `scheduled` and due at or before `cutoff`. A collection
   * group query, so one sweep sees all users; it needs the composite index on `reminders`
   * (`status` Asc, `remindAt` Asc) described in the README. Empty when the store is unavailable.
   *
   * `cutoff` is deliberately `now + interval`, not `now`: a reminder due before the next tick is
   * delivered by this one, so notifications land early rather than late.
   */
  async findDue(cutoff: Date): Promise<DueReminder[]> {
    const db = this.firestore.db;
    if (!db) {
      return [];
    }

    const snapshot = await db
      .collectionGroup('reminders')
      .where('status', '==', 'scheduled')
      .where('remindAt', '<=', Timestamp.fromDate(cutoff))
      .get();

    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ref: doc.ref,
        userId: typeof data.userId === 'number' ? data.userId : Number(doc.ref.parent.parent?.id),
        chatId: typeof data.chatId === 'number' ? data.chatId : 0,
        title: typeof data.title === 'string' ? data.title : '',
        eventAt: typeof data.eventAt === 'string' ? data.eventAt : '',
      };
    });
  }

  /**
   * Claims one due reminder for delivery: inside a transaction, re-read it and flip it from
   * `scheduled` to `sent` only if it is still `scheduled`. Returns whether this caller won.
   *
   * This ordering - claim, then send - is what makes a double-notify impossible. Two overlapping
   * sweeps can both see the same reminder in `findDue`, but only one transaction commits the flip,
   * and only that winner sends. A loser abandons the reminder silently.
   */
  async claimForSend(ref: DocumentReference, now: Date): Promise<boolean> {
    const db = this.firestore.db;
    if (!db) {
      return false;
    }

    return db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('status') !== 'scheduled') {
        return false;
      }

      // The scheduled -> sent flip. `sentAt` records when the delivery was claimed.
      tx.update(ref, { status: 'sent', sentAt: Timestamp.fromDate(now) });
      return true;
    });
  }

  /**
   * Loads one reminder from its owner's subcollection for the callback owner check. The path is
   * keyed by `userId`, so a tap from anyone else simply finds nothing; the `userId` field is
   * compared as well so a stray document can never be acted on by the wrong person.
   */
  async getOwned(userId: number, id: string): Promise<OwnedReminder | undefined> {
    const db = this.firestore.db;
    if (!db || !id) {
      return undefined;
    }

    const snapshot = await this.ref(db, userId, id).get();
    if (!snapshot.exists) {
      return undefined;
    }

    const data = snapshot.data() ?? {};
    if (data.userId !== userId) {
      return undefined;
    }

    return {
      id: snapshot.id,
      userId,
      status: typeof data.status === 'string' ? data.status : '',
      title: typeof data.title === 'string' ? data.title : '',
    };
  }

  /** Marks a delivered reminder done. No time changes - `remindAt` and `eventAt` stay as they were. */
  async ack(userId: number, id: string, now: Date): Promise<void> {
    const db = this.firestore.db;
    if (!db) {
      return;
    }

    await this.ref(db, userId, id).update({ status: 'acked', ackedAt: Timestamp.fromDate(now) });
    this.logger.log(`Acked reminder ${id} for user ${userId}`);
  }

  /**
   * Re-arms a delivered reminder for a later notification. Only `remindAt` moves: `eventAt` is when
   * the thing itself happens and is never rewritten by a snooze.
   */
  async snooze(userId: number, id: string, newRemindAt: Date): Promise<void> {
    const db = this.firestore.db;
    if (!db) {
      return;
    }

    await this.ref(db, userId, id).update({
      remindAt: Timestamp.fromDate(newRemindAt),
      status: 'scheduled',
    });
    this.logger.log(`Snoozed reminder ${id} for user ${userId}`);
  }

  private ref(db: NonNullable<FirestoreService['db']>, userId: number, id: string): DocumentReference {
    return db.collection('users').doc(String(userId)).collection('reminders').doc(id);
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
