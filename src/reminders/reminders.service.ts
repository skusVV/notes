import { DocumentData, DocumentReference, FieldValue, Timestamp } from '@google-cloud/firestore';
import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { FirestoreService } from '../firestore/firestore.service';
import { computeExpireAt, EXPIRE_HOURS, normalizeEventAt } from './event-at';
import { resolveNotifyTimes } from './notify-times';

/** The subcollection holding one document per nudge. Also the collection group the sweep queries. */
export const NOTIFICATIONS = 'notifications';

/** The part of a classified reminder the store needs; the rest of the draft is not persisted yet. */
export interface ReminderDraftInput {
  title: string;
  eventAt?: string;
  /**
   * When to nudge: relative keywords ("evening_before") or ISO instants, as the classifier returned
   * them. Empty or unresolvable means one notification at `eventAt` - see {@link resolveNotifyTimes}.
   */
  notifyAt?: string[];
}

/** One nudge in the `/export` output. `at` is rendered in the same local-ISO form as `eventAt`. */
export interface NotificationExport {
  id: string;
  at: string;
  status: string;
}

/** The `/export` shape for one reminder. Timestamps are rendered as strings for a JSON reader. */
export interface ReminderExport {
  id: string;
  originalText: string;
  title: string;
  eventAt: string;
  createdAt: string;
  expireAt: string;
  status: string;
  /** Every nudge this reminder owns, ascending. One entry for a reminder that named no extra time. */
  notifications: NotificationExport[];
}

/**
 * A notification the sweep found due. Carries the document reference so the claim transaction can
 * re-read exactly this document, plus only the denormalised fields a delivery needs - so the sweep
 * never reads the parent reminder.
 */
export interface DueNotification {
  id: string;
  ref: DocumentReference;
  reminderId: string;
  userId: number;
  chatId: number;
  title: string;
  eventAt: string;
}

/** A notification loaded for an owner check, before a callback acts on it. */
export interface OwnedNotification {
  id: string;
  ref: DocumentReference;
  userId: number;
  status: string;
}

/**
 * Persists reminders at `users/{userId}/reminders/{autoId}` with one
 * `.../notifications/{autoId}` document per nudge, and reads them back. Degrades with the
 * Firestore provider: when the store is unavailable, `create` reports it could not write and `list`
 * returns nothing, so text handling survives an unconfigured project (same pattern as the model
 * services).
 *
 * Notifications, not the reminder, are the delivery source of truth: one appointment can deserve
 * several nudges, and each is claimed, sent, acked and snoozed on its own.
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(private readonly firestore: FirestoreService) {}

  get available(): boolean {
    return this.firestore.available;
  }

  /**
   * Validates and normalises `eventAt`, resolves the requested notify times, then writes one
   * reminder plus its notifications in a single batch. Returns the new reminder id, or `undefined`
   * when the store is unavailable or the time is not a resolvable future instant (no write) - the
   * caller then treats the reminder as unresolved and does not claim a store.
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
    const document: DocumentData = {
      userId,
      chatId,
      originalText,
      title: draft.title,
      eventAt,
      eventAtUtc: Timestamp.fromDate(eventInstant),
      createdAt: Timestamp.fromDate(now),
      // The field the Firestore TTL policy targets, so an expired reminder is reaped automatically.
      expireAt: Timestamp.fromDate(computeExpireAt(eventAt)),
      status: 'scheduled',
    };

    const ref = db.collection('users').doc(String(userId)).collection('reminders').doc();
    const notifyAt = resolveNotifyTimes(eventAt, draft.notifyAt, now);

    const batch = db.batch();
    batch.set(ref, document);
    for (const atLocal of notifyAt) {
      batch.set(ref.collection(NOTIFICATIONS).doc(), {
        at: Timestamp.fromDate(DateTime.fromISO(atLocal, { setZone: true }).toJSDate()),
        atLocal,
        status: 'scheduled',
        // Denormalised so the sweep can deliver straight from the collection-group query result
        // without reading the parent reminder.
        reminderId: ref.id,
        userId,
        chatId,
        title: draft.title,
        eventAt,
        // Firestore does not cascade a delete into subcollections, so a notification carries its
        // own TTL field; without it the parent's reaping would leave orphans behind.
        expireAt: Timestamp.fromDate(computeExpireAt(atLocal)),
      });
    }
    await batch.commit();

    // Log the id, the user and the count, never the reminder content - these are private notes.
    this.logger.log(
      `Stored reminder ${ref.id} for user ${userId} with ${notifyAt.length} notification(s)`,
    );
    return ref.id;
  }

  /**
   * That user's reminders, ordered by `eventAt` ascending, each with its notifications. One extra
   * read per reminder: `/export` is a hand-typed command over a personal store, so the simple read
   * is preferred to denormalising the list onto the parent and keeping it in sync.
   * Empty when the store is unavailable.
   */
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

    return Promise.all(
      snapshot.docs.map(async (doc) => {
        const notifications = await doc.ref.collection(NOTIFICATIONS).orderBy('at', 'asc').get();
        return this.toExport(
          doc.id,
          doc.data(),
          notifications.docs.map((n) => this.toNotificationExport(n.id, n.data())),
        );
      }),
    );
  }

  /**
   * Every user's notifications that are still `scheduled` and due at or before `cutoff`. A
   * collection group query, so one sweep sees all users; it needs the composite index on
   * `notifications` (`status` Asc, `at` Asc) described in the README. Empty when the store is
   * unavailable.
   *
   * `cutoff` is deliberately `now + interval`, not `now`: a notification due before the next tick is
   * delivered by this one, so nudges land early rather than late.
   */
  async findDue(cutoff: Date): Promise<DueNotification[]> {
    const db = this.firestore.db;
    if (!db) {
      return [];
    }

    const snapshot = await db
      .collectionGroup(NOTIFICATIONS)
      .where('status', '==', 'scheduled')
      .where('at', '<=', Timestamp.fromDate(cutoff))
      .get();

    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ref: doc.ref,
        reminderId: typeof data.reminderId === 'string' ? data.reminderId : (doc.ref.parent.parent?.id ?? ''),
        userId: typeof data.userId === 'number' ? data.userId : Number(doc.ref.parent.parent?.parent.parent?.id),
        chatId: typeof data.chatId === 'number' ? data.chatId : 0,
        title: typeof data.title === 'string' ? data.title : '',
        eventAt: typeof data.eventAt === 'string' ? data.eventAt : '',
      };
    });
  }

  /**
   * The one-time migration off the scalar `remindAt` that 0002/0003 delivered from: each reminder
   * still carrying one becomes a reminder with a single `scheduled` notification, and the scalar is
   * deleted so it is converted exactly once. Returns how many were converted.
   *
   * Driven from the sweep rather than from a deploy hook: the sweep is the only thing that has to
   * see these reminders, and running it there means no separate one-shot command and no window
   * where a legacy reminder is invisible. It reuses the old `reminders` (`status`, `remindAt`)
   * index, so it needs nothing new; once the last one is converted the query matches nothing.
   */
  async backfillLegacy(cutoff: Date, limit = 50): Promise<number> {
    const db = this.firestore.db;
    if (!db) {
      return 0;
    }

    const legacy = await db
      .collectionGroup('reminders')
      .where('status', '==', 'scheduled')
      .where('remindAt', '<=', Timestamp.fromDate(cutoff))
      .limit(limit)
      .get();

    if (legacy.empty) {
      return 0;
    }

    let converted = 0;
    for (const doc of legacy.docs) {
      const data = doc.data();
      const existing = await doc.ref.collection(NOTIFICATIONS).limit(1).get();
      const batch = db.batch();

      if (existing.empty && data.remindAt instanceof Timestamp) {
        const eventAt = typeof data.eventAt === 'string' ? data.eventAt : '';
        const atLocal = localFromTimestamp(data.remindAt, eventAt);
        batch.set(doc.ref.collection(NOTIFICATIONS).doc(), {
          at: data.remindAt,
          atLocal,
          status: 'scheduled',
          reminderId: doc.id,
          userId: typeof data.userId === 'number' ? data.userId : Number(doc.ref.parent.parent?.id),
          chatId: typeof data.chatId === 'number' ? data.chatId : 0,
          title: typeof data.title === 'string' ? data.title : '',
          eventAt,
          // The parent's own TTL instant where it has one; otherwise derived from the nudge, so a
          // legacy document with an odd shape still cannot produce an invalid date.
          expireAt:
            data.expireAt instanceof Timestamp
              ? data.expireAt
              : Timestamp.fromMillis(data.remindAt.toMillis() + EXPIRE_HOURS * 3_600_000),
        });
        converted += 1;
      }

      // Dropping the scalar is what makes this idempotent: a converted reminder never matches the
      // query again, so a second tick cannot give it a second notification.
      batch.update(doc.ref, { remindAt: FieldValue.delete() });
      await batch.commit();
    }

    this.logger.log(`Backfilled ${converted} legacy reminder(s) into notifications`);
    return converted;
  }

  /**
   * Claims one due notification for delivery: inside a transaction, re-read it and flip it from
   * `scheduled` to `sent` only if it is still `scheduled`. Returns whether this caller won.
   *
   * This ordering - claim, then send - is what makes a double-notify impossible. Two overlapping
   * sweeps can both see the same notification in `findDue`, but only one transaction commits the
   * flip, and only that winner sends. A loser abandons it silently. The flip is per notification,
   * so the reminder's other nudges are untouched.
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
   * Loads one notification for the callback owner check. A button carries only the notification id
   * (Telegram's `callback_data` is capped at 64 bytes, and the id alone is what the three buttons
   * key on), so the id is looked for under *this user's* reminders only: every candidate path is
   * rooted at `users/{userId}`, which means a tap from anyone else finds nothing at all rather than
   * relying on a field comparison. The denormalised `userId` is still compared, so a stray document
   * written under the wrong parent can never be acted on either.
   *
   * Deliberately a path walk instead of a collection-group query: it needs no index, and one
   * `getAll` fetches every candidate in a single round trip.
   */
  async getOwnedNotification(userId: number, id: string): Promise<OwnedNotification | undefined> {
    const db = this.firestore.db;
    if (!db || !id) {
      return undefined;
    }

    const reminders = await db
      .collection('users')
      .doc(String(userId))
      .collection('reminders')
      .get();
    const candidates = reminders.docs.map((doc) => doc.ref.collection(NOTIFICATIONS).doc(id));
    if (candidates.length === 0) {
      return undefined;
    }

    const snapshots = await db.getAll(...candidates);
    const found = snapshots.find((snapshot) => snapshot.exists);
    if (!found) {
      return undefined;
    }

    const data = found.data() ?? {};
    if (data.userId !== userId) {
      return undefined;
    }

    return {
      id: found.id,
      ref: found.ref,
      userId,
      status: typeof data.status === 'string' ? data.status : '',
    };
  }

  /**
   * Marks one delivered notification done. No time changes, and nothing else moves: the reminder's
   * other notifications still fire, and `eventAt` is never rewritten.
   */
  async ackNotification(ref: DocumentReference, userId: number, now: Date): Promise<void> {
    await ref.update({ status: 'acked', ackedAt: Timestamp.fromDate(now) });
    this.logger.log(`Acked notification ${ref.id} for user ${userId}`);
  }

  /**
   * Re-arms one delivered notification for later. Only that notification's `at`/`atLocal` move:
   * `eventAt` is when the thing itself happens, and the reminder's other notifications are left
   * exactly where they were.
   */
  async snoozeNotification(
    ref: DocumentReference,
    userId: number,
    newAt: Date,
    atLocal: string,
  ): Promise<void> {
    await ref.update({
      at: Timestamp.fromDate(newAt),
      atLocal,
      status: 'scheduled',
      // The TTL must follow the notification, or a snooze past the original expiry would be reaped
      // before it ever fires.
      expireAt: Timestamp.fromDate(computeExpireAt(atLocal)),
    });
    this.logger.log(`Snoozed notification ${ref.id} for user ${userId}`);
  }

  private toExport(
    id: string,
    data: DocumentData,
    notifications: NotificationExport[],
  ): ReminderExport {
    return {
      id,
      originalText: typeof data.originalText === 'string' ? data.originalText : '',
      title: typeof data.title === 'string' ? data.title : '',
      eventAt: typeof data.eventAt === 'string' ? data.eventAt : '',
      createdAt: toIso(data.createdAt),
      expireAt: toIso(data.expireAt),
      status: typeof data.status === 'string' ? data.status : '',
      notifications,
    };
  }

  private toNotificationExport(id: string, data: DocumentData): NotificationExport {
    return {
      id,
      // atLocal is the canonical local-ISO-with-offset form, written on every create and snooze.
      // The Timestamp is the fallback, rendered in the zone the reminder's eventAt carries.
      at:
        typeof data.atLocal === 'string' && data.atLocal
          ? data.atLocal
          : localFromTimestamp(data.at, typeof data.eventAt === 'string' ? data.eventAt : ''),
      status: typeof data.status === 'string' ? data.status : '',
    };
  }
}

/** Serialise a Firestore Timestamp as a plain ISO string; anything else becomes empty. */
function toIso(value: unknown): string {
  return value instanceof Timestamp ? value.toDate().toISOString() : '';
}

/** Render a Timestamp in the zone an `eventAt` string carries, in the same canonical local form. */
function localFromTimestamp(value: unknown, eventAt: string): string {
  if (!(value instanceof Timestamp)) {
    return '';
  }
  const zone = DateTime.fromISO(eventAt, { setZone: true }).zone;
  const local = DateTime.fromJSDate(value.toDate(), { zone });
  return local.toISO({ suppressMilliseconds: true, includeOffset: true }) ?? '';
}
