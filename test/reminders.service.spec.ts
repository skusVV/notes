import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { Recurrence } from '../src/reminders/recurrence';
import {
  DueNotification,
  MAX_SEND_ATTEMPTS,
  NOTIFICATIONS,
  RemindersService,
} from '../src/reminders/reminders.service';

const USER = 900000001;
const CHAT = 900000001;
const NOW = new Date('2026-09-16T09:00:00+03:00');
const EVENT_AT = '2026-09-22T14:00:00+03:00';

/** "Bob has a birthday on June 12", as the classifier hands it over. */
const BIRTHDAY: Recurrence = {
  freq: 'yearly',
  month: 6,
  day: 12,
  atLocal: '09:00',
  timezone: 'Europe/Kyiv',
};

interface Write {
  path: string;
  data: Record<string, unknown>;
}

/**
 * The thinnest stand-in for Firestore that `create` actually uses: auto-id document refs, nested
 * subcollections, and a batch that records what would be written. Enough to assert the document
 * shapes without a real database.
 */
function fakeFirestore() {
  const writes: Write[] = [];
  let auto = 0;

  const makeRef = (path: string) => ({
    id: path.split('/').pop() as string,
    path,
    collection: (name: string) => makeCollection(`${path}/${name}`),
  });

  const makeCollection = (path: string) => ({
    doc: (id?: string) => makeRef(`${path}/${id ?? `auto${++auto}`}`),
  });

  const db = {
    collection: (name: string) => makeCollection(name),
    batch: () => ({
      set: (ref: { path: string }, data: Record<string, unknown>) =>
        writes.push({ path: ref.path, data }),
      commit: async () => undefined,
    }),
  };

  return { writes, service: new RemindersService({ db, available: true } as never) };
}

/** The notification documents a create() produced, in the order they were written. */
function notifications(writes: Write[]): Record<string, unknown>[] {
  return writes.filter((w) => w.path.includes(`/${NOTIFICATIONS}/`)).map((w) => w.data);
}

function reminder(writes: Write[]): Record<string, unknown> {
  return writes.filter((w) => !w.path.includes(`/${NOTIFICATIONS}/`))[0].data;
}

describe('RemindersService.create', () => {
  let store: ReturnType<typeof fakeFirestore>;

  beforeEach(() => {
    store = fakeFirestore();
  });

  // acceptance: two-notifications-captured - one reminder, exactly two scheduled notifications
  it('writes one reminder and one notification per resolved notify time', async () => {
    const id = await store.service.create(
      USER,
      CHAT,
      { title: 'doctor appointment', eventAt: EVENT_AT, notifyAt: ['evening_before', 'morning_of'] },
      'I have a doctor appointment on the 22nd at 2PM, remind me the evening before and the morning of',
      NOW,
    );

    expect(id).toBeTruthy();
    expect(reminder(store.writes).eventAt).toBe(EVENT_AT);

    const written = notifications(store.writes);
    expect(written.map((n) => n.atLocal)).toEqual([
      '2026-09-21T19:00:00+03:00',
      '2026-09-22T09:00:00+03:00',
    ]);
    for (const notification of written) {
      expect(notification.status).toBe('scheduled');
      // Denormalised so the sweep never has to read the parent reminder.
      expect(notification.reminderId).toBe(id);
      expect(notification.userId).toBe(USER);
      expect(notification.chatId).toBe(CHAT);
      expect(notification.title).toBe('doctor appointment');
      expect(notification.eventAt).toBe(EVENT_AT);
      expect(notification.at).toBeInstanceOf(Timestamp);
      // Its own TTL: Firestore does not cascade the parent's expiry into a subcollection.
      expect(notification.expireAt).toBeInstanceOf(Timestamp);
    }
    expect((written[0].at as Timestamp).toDate()).toEqual(new Date('2026-09-21T19:00:00+03:00'));
  });

  // acceptance: single-default-notification - the single-time path is unchanged
  it('writes exactly one notification at eventAt when no notify time was named', async () => {
    await store.service.create(
      USER,
      CHAT,
      { title: 'pay rent', eventAt: '2026-09-25T12:00:00+03:00' },
      'Remind me on the 25th at 12 to pay rent',
      NOW,
    );

    const written = notifications(store.writes);
    expect(written).toHaveLength(1);
    expect(written[0].atLocal).toBe('2026-09-25T12:00:00+03:00');
    expect(written[0].status).toBe('scheduled');
  });

  // The scalar remindAt is retired: notifications are the delivery source of truth.
  it('no longer writes a scalar remindAt on the reminder', async () => {
    await store.service.create(USER, CHAT, { title: 'pay rent', eventAt: EVENT_AT }, 'rent', NOW);

    expect(reminder(store.writes)).not.toHaveProperty('remindAt');
  });

  it('writes nothing when the time is not a resolvable future instant', async () => {
    expect(
      await store.service.create(USER, CHAT, { title: 'no time' }, 'remind me sometime', NOW),
    ).toBeUndefined();
    expect(
      await store.service.create(
        USER,
        CHAT,
        { title: 'past' , eventAt: '2026-09-15T12:00:00+03:00' },
        'remind me yesterday',
        NOW,
      ),
    ).toBeUndefined();
    expect(store.writes).toHaveLength(0);
  });

  it('does not write when the store is unavailable', async () => {
    const service = new RemindersService({ db: undefined, available: false } as never);

    expect(
      await service.create(USER, CHAT, { title: 'x', eventAt: EVENT_AT }, 'x', NOW),
    ).toBeUndefined();
  });
});

describe('RemindersService.create for a recurring reminder', () => {
  let store: ReturnType<typeof fakeFirestore>;

  beforeEach(() => {
    store = fakeFirestore();
  });

  // acceptance: birthday-captured-yearly - stored with the rule, and with exactly one scheduled
  // notification at the next occurrence (June 12 2026 has passed, so 2027)
  it('stores the rule with one notification at the next occurrence', async () => {
    const id = await store.service.create(
      USER,
      CHAT,
      { title: "Bob's birthday", recurrence: BIRTHDAY },
      'Bob has a birthday on June 12',
      NOW,
    );

    expect(id).toBeTruthy();
    const written = reminder(store.writes);
    expect(written.recurrence).toEqual(BIRTHDAY);
    expect(written.eventAt).toBe('2027-06-12T09:00:00+03:00');

    const nudges = notifications(store.writes);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].atLocal).toBe('2027-06-12T09:00:00+03:00');
    expect(nudges[0].status).toBe('scheduled');
    // Denormalised so the sweep can roll it forward without reading the parent.
    expect(nudges[0].recurrence).toEqual(BIRTHDAY);
  });

  // acceptance: never-expires - the TTL policy only deletes documents that HAVE the field, so its
  // absence is what makes a birthday permanent. Both documents, since TTL does not cascade.
  it('writes no expireAt on the reminder or its notification', async () => {
    await store.service.create(
      USER,
      CHAT,
      { title: "Bob's birthday", recurrence: BIRTHDAY },
      'Bob has a birthday on June 12',
      NOW,
    );

    expect(reminder(store.writes)).not.toHaveProperty('expireAt');
    expect(notifications(store.writes)[0]).not.toHaveProperty('expireAt');
  });

  it('needs no eventAt, and ignores extra notify times', async () => {
    await store.service.create(
      USER,
      CHAT,
      {
        title: 'trash',
        recurrence: {
          freq: 'weekly',
          weekday: 'monday',
          atLocal: '08:00',
          timezone: 'Europe/Kyiv',
        },
        notifyAt: ['evening_before'],
      },
      'Take out the trash every Monday at 8am',
      NOW,
    );

    const nudges = notifications(store.writes);
    expect(nudges).toHaveLength(1);
    // acceptance: weekly-recurrence - the next Monday after Wednesday 16 September 2026
    expect(nudges[0].atLocal).toBe('2026-09-21T08:00:00+03:00');
  });

  it('writes nothing when the rule cannot be resolved to an occurrence', async () => {
    expect(
      await store.service.create(
        USER,
        CHAT,
        { title: 'nowhere', recurrence: { ...BIRTHDAY, timezone: 'Not/AZone' } },
        'every year somewhere',
        NOW,
      ),
    ).toBeUndefined();
    expect(store.writes).toHaveLength(0);
  });

  // 0023 acceptance: birthday-shown-without-time - the flag lands on the reminder document
  it('writes allDay: true on a recurring reminder drafted as all-day', async () => {
    await store.service.create(
      USER,
      CHAT,
      { title: "Bob's birthday", recurrence: BIRTHDAY, allDay: true },
      'Bob has a birthday on June 12',
      NOW,
    );

    expect(reminder(store.writes).allDay).toBe(true);
  });

  it('writes no allDay field on a recurring reminder with a named time', async () => {
    await store.service.create(
      USER,
      CHAT,
      {
        title: 'stretch',
        recurrence: { freq: 'daily', atLocal: '15:00', timezone: 'Europe/Kyiv' },
      },
      'Remind me every day at 15:00 to stretch',
      NOW,
    );

    expect(reminder(store.writes)).not.toHaveProperty('allDay');
  });
});

describe('RemindersService.create allDay on a one-off', () => {
  // A one-off is never all-day: the flag is honoured only on the recurring path.
  it('ignores allDay on a one-off draft', async () => {
    const store = fakeFirestore();

    await store.service.create(
      USER,
      CHAT,
      { title: 'pay rent', eventAt: EVENT_AT, allDay: true },
      'rent',
      NOW,
    );

    expect(reminder(store.writes)).not.toHaveProperty('allDay');
  });
});

/**
 * A fake for the roll-forward transaction: it records what the transaction would write, and
 * `alreadyScheduled` simulates the reminder already owning a scheduled notification, which is the
 * idempotency guard's trigger.
 */
function fakeTransaction(alreadyScheduled: boolean) {
  const sets: Write[] = [];
  const updates: Write[] = [];
  let queries = 0;

  const notificationsCollection = {
    where: () => ({ limit: () => ({ kind: 'query' }) }),
    doc: () => ({ path: `users/${USER}/reminders/reminder-1/${NOTIFICATIONS}/auto-next` }),
  };
  const reminderRef = {
    id: 'reminder-1',
    path: `users/${USER}/reminders/reminder-1`,
    collection: () => notificationsCollection,
  };
  const notification: DueNotification = {
    id: 'notification-1',
    ref: { parent: { parent: reminderRef } } as never,
    reminderId: 'reminder-1',
    userId: USER,
    chatId: CHAT,
    title: "Bob's birthday",
    eventAt: '2027-06-12T09:00:00+03:00',
    atLocal: '2027-06-12T09:00:00+03:00',
    recurrence: BIRTHDAY,
  };

  const db = {
    runTransaction: async <T>(
      body: (tx: {
        get: (query: unknown) => Promise<{ empty: boolean }>;
        set: (ref: { path: string }, data: Record<string, unknown>) => void;
        update: (ref: { path: string }, data: Record<string, unknown>) => void;
      }) => Promise<T>,
    ): Promise<T> =>
      body({
        get: async () => {
          queries += 1;
          return { empty: !alreadyScheduled };
        },
        set: (ref, data) => sets.push({ path: ref.path, data }),
        update: (ref, data) => updates.push({ path: ref.path, data }),
      }),
  };

  return {
    sets,
    updates,
    notification,
    queryCount: () => queries,
    service: new RemindersService({ db, available: true } as never),
  };
}

describe('RemindersService.snoozeNotification', () => {
  function fakeNotification() {
    const updates: Record<string, unknown>[] = [];
    const ref = { id: 'notification-1', update: async (data: Record<string, unknown>) => void updates.push(data) };
    return { updates, ref, service: new RemindersService({ db: {}, available: true } as never) };
  }

  it('keeps a one-off notification on the TTL policy when it is snoozed', async () => {
    const store = fakeNotification();

    await store.service.snoozeNotification(
      store.ref as never,
      USER,
      new Date('2026-09-22T15:00:00+03:00'),
      '2026-09-22T15:00:00+03:00',
    );

    expect(store.updates[0].status).toBe('scheduled');
    expect(store.updates[0].expireAt).toBeInstanceOf(Timestamp);
  });

  // Invariant: a recurring reminder is never TTL-deleted. A snooze is the one path that could have
  // quietly handed its notification an expireAt and put it back in reach of the policy.
  it('does not give a recurring notification an expireAt', async () => {
    const store = fakeNotification();

    await store.service.snoozeNotification(
      store.ref as never,
      USER,
      new Date('2027-06-12T10:00:00+03:00'),
      '2027-06-12T10:00:00+03:00',
      true,
    );

    expect(store.updates[0].status).toBe('scheduled');
    expect(store.updates[0]).not.toHaveProperty('expireAt');
  });
});

/**
 * A one-document fake for the release transaction: `tx.get` returns the stored fields and
 * `tx.update` records (and applies) the write, so the state after a release can be asserted.
 */
function fakeClaimedNotification(data: Record<string, unknown> | undefined) {
  const updates: Record<string, unknown>[] = [];
  const ref = { id: 'notification-1' };
  const db = {
    runTransaction: async <T>(
      body: (tx: {
        get: (ref: unknown) => Promise<{ exists: boolean; get: (field: string) => unknown }>;
        update: (ref: unknown, data: Record<string, unknown>) => void;
      }) => Promise<T>,
    ): Promise<T> =>
      body({
        get: async () => ({ exists: data !== undefined, get: (field: string) => data?.[field] }),
        update: (_ref, write) => {
          updates.push(write);
        },
      }),
  };
  return { updates, ref, service: new RemindersService({ db, available: true } as never) };
}

describe('RemindersService.releaseAfterFailedSend', () => {
  it('allows three attempts', () => {
    expect(MAX_SEND_ATTEMPTS).toBe(3);
  });

  // acceptance: repro-fixed (store half) - the claimed notification goes back to `scheduled`, so the
  // next sweep's findDue sees it again, with the attempt counted
  it('puts a first failed send back to scheduled and counts the attempt', async () => {
    const store = fakeClaimedNotification({ status: 'sent' });

    expect(await store.service.releaseAfterFailedSend(store.ref as never)).toBe('retry');
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0].status).toBe('scheduled');
    expect(store.updates[0].sendAttempts).toBe(1);
    // The claim's sentAt is cleared: nothing was sent.
    expect(store.updates[0].sentAt).toBeInstanceOf(FieldValue);
  });

  it('counts on from the stored attempts', async () => {
    const store = fakeClaimedNotification({ status: 'sent', sendAttempts: 1 });

    expect(await store.service.releaseAfterFailedSend(store.ref as never)).toBe('retry');
    expect(store.updates[0]).toMatchObject({ status: 'scheduled', sendAttempts: 2 });
  });

  // acceptance: gives-up (store half) - the third failure is final
  it('marks the notification failed on the third failed attempt', async () => {
    const store = fakeClaimedNotification({ status: 'sent', sendAttempts: 2 });

    expect(await store.service.releaseAfterFailedSend(store.ref as never)).toBe('failed');
    expect(store.updates[0]).toMatchObject({ status: 'failed', sendAttempts: 3 });
  });

  it('leaves a notification that is no longer claimed untouched', async () => {
    for (const data of [{ status: 'acked' }, { status: 'scheduled' }, undefined]) {
      const store = fakeClaimedNotification(data);

      expect(await store.service.releaseAfterFailedSend(store.ref as never)).toBeUndefined();
      expect(store.updates).toHaveLength(0);
    }
  });

  it('does nothing when the store is unavailable', async () => {
    const service = new RemindersService({ db: undefined, available: false } as never);

    expect(await service.releaseAfterFailedSend({ id: 'notification-1' } as never)).toBeUndefined();
  });
});

describe('RemindersService.enqueueNextOccurrence', () => {
  // acceptance: recurrence-rolls-forward - the fired occurrence is 2027, so the one armed is 2028.
  // The tick's own "now" is 10 minutes BEFORE the fired occurrence, which is exactly the case that
  // would re-arm the same occurrence if it were measured from now.
  it('arms the occurrence after the one that fired', async () => {
    const store = fakeTransaction(false);

    const next = await store.service.enqueueNextOccurrence(
      store.notification,
      new Date('2027-06-12T08:50:00+03:00'),
    );

    expect(next).toBe('2028-06-12T09:00:00+03:00');
    expect(store.sets).toHaveLength(1);
    const written = store.sets[0].data;
    expect(written.atLocal).toBe('2028-06-12T09:00:00+03:00');
    expect(written.status).toBe('scheduled');
    expect(written.recurrence).toEqual(BIRTHDAY);
    expect(written.reminderId).toBe('reminder-1');
    expect(written.userId).toBe(USER);
    // Still exempt from the TTL policy.
    expect(written).not.toHaveProperty('expireAt');
    // The reminder's eventAt follows the armed occurrence.
    expect(store.updates[0].data.eventAt).toBe('2028-06-12T09:00:00+03:00');
  });

  // acceptance (unit half): "enqueue exactly one next occurrence" idempotency. A retried tick must
  // not leave two future notifications.
  it('writes nothing when a scheduled notification already exists', async () => {
    const store = fakeTransaction(true);

    expect(
      await store.service.enqueueNextOccurrence(store.notification, NOW),
    ).toBeUndefined();
    expect(store.queryCount()).toBe(1);
    expect(store.sets).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
  });

  it('does nothing for a one-off notification', async () => {
    const store = fakeTransaction(false);

    expect(
      await store.service.enqueueNextOccurrence(
        { ...store.notification, recurrence: undefined },
        NOW,
      ),
    ).toBeUndefined();
    expect(store.sets).toHaveLength(0);
  });

  it('does nothing when the store is unavailable', async () => {
    const service = new RemindersService({ db: undefined, available: false } as never);
    const store = fakeTransaction(false);

    expect(await service.enqueueNextOccurrence(store.notification, NOW)).toBeUndefined();
    expect(store.sets).toHaveLength(0);
  });
});

/**
 * A read-only fake holding one reminder document and the notification documents under it.
 * `reminderData` overrides fields on that reminder, which is how the recurring shape is exercised.
 */
function fakeStore(
  notificationDocs: { id: string; data: Record<string, unknown> }[],
  reminderData: Record<string, unknown> = {},
) {
  const snapshot = (docs: { id: string; data: Record<string, unknown> }[]) => ({
    docs: docs.map((doc) => ({ id: doc.id, data: () => doc.data, ref: notificationsRef })),
  });
  const notificationsRef = {
    collection: () => ({ orderBy: () => ({ get: async () => snapshot(notificationDocs) }) }),
  };

  const db = {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          orderBy: () => ({
            get: async () =>
              snapshot([
                {
                  id: 'reminder-1',
                  data: {
                    userId: USER,
                    chatId: CHAT,
                    originalText: 'doctor on the 22nd at 2PM',
                    title: 'doctor appointment',
                    eventAt: EVENT_AT,
                    createdAt: Timestamp.fromDate(NOW),
                    expireAt: Timestamp.fromDate(new Date('2026-09-23T14:00:00+03:00')),
                    status: 'scheduled',
                    ...reminderData,
                  },
                },
              ]),
          }),
        }),
      }),
    }),
  };

  return new RemindersService({ db, available: true } as never);
}

describe('RemindersService.list', () => {
  // acceptance: two-notifications-captured / independent-delivery - /export carries every
  // notification with its id, local time and its own status
  it('exports each reminder with its notifications and without the retired remindAt', async () => {
    const service = fakeStore([
      {
        id: 'notification-1',
        data: { atLocal: '2026-09-21T19:00:00+03:00', status: 'sent', eventAt: EVENT_AT },
      },
      {
        id: 'notification-2',
        data: { atLocal: '2026-09-22T09:00:00+03:00', status: 'scheduled', eventAt: EVENT_AT },
      },
    ]);

    const [reminder] = await service.list(USER);

    expect(reminder.eventAt).toBe(EVENT_AT);
    expect(reminder).not.toHaveProperty('remindAt');
    expect(reminder.notifications).toEqual([
      { id: 'notification-1', at: '2026-09-21T19:00:00+03:00', status: 'sent' },
      { id: 'notification-2', at: '2026-09-22T09:00:00+03:00', status: 'scheduled' },
    ]);
  });

  it('renders a notification with no atLocal in the zone its eventAt carries', async () => {
    const service = fakeStore([
      {
        id: 'notification-1',
        data: {
          at: Timestamp.fromDate(new Date('2026-09-22T09:00:00+03:00')),
          status: 'scheduled',
          eventAt: EVENT_AT,
        },
      },
    ]);

    const [reminder] = await service.list(USER);

    expect(reminder.notifications[0].at).toBe('2026-09-22T09:00:00+03:00');
  });

  it('exports recurrence as null for a one-off', async () => {
    const service = fakeStore([
      { id: 'notification-1', data: { atLocal: EVENT_AT, status: 'scheduled' } },
    ]);

    const [reminder] = await service.list(USER);

    expect(reminder.recurrence).toBeNull();
    expect(reminder.expireAt).toBe(new Date('2026-09-23T14:00:00+03:00').toISOString());
  });

  // acceptance: birthday-captured-yearly / never-expires - /export carries the rule, and expireAt
  // comes back null because the stored document has no such field at all
  it('exports the rule and a null expireAt for a recurring reminder', async () => {
    const service = fakeStore(
      [
        {
          id: 'notification-1',
          data: { atLocal: '2027-06-12T09:00:00+03:00', status: 'scheduled' },
        },
      ],
      { recurrence: { ...BIRTHDAY }, expireAt: undefined, eventAt: '2027-06-12T09:00:00+03:00' },
    );

    const [reminder] = await service.list(USER);

    expect(reminder.recurrence).toEqual(BIRTHDAY);
    expect(reminder.expireAt).toBeNull();
    expect(reminder.notifications).toEqual([
      { id: 'notification-1', at: '2027-06-12T09:00:00+03:00', status: 'scheduled' },
    ]);
    // JSON is what the verifier reads, and an absent expireAt must survive as an explicit null.
    expect(JSON.parse(JSON.stringify(reminder)).expireAt).toBeNull();
  });

  it('exports a stored rule it can no longer resolve as null rather than as a broken rule', async () => {
    const service = fakeStore(
      [{ id: 'notification-1', data: { atLocal: EVENT_AT, status: 'scheduled' } }],
      { recurrence: { freq: 'weekly', atLocal: '08:00', timezone: 'Europe/Kyiv' } },
    );

    const [reminder] = await service.list(USER);

    expect(reminder.recurrence).toBeNull();
  });

  // 0023: /export carries allDay as a boolean, false when the stored field is absent
  it('exports allDay as true only when the stored reminder carries it', async () => {
    const plain = fakeStore([{ id: 'notification-1', data: { atLocal: EVENT_AT, status: 'scheduled' } }]);
    const flagged = fakeStore(
      [{ id: 'notification-1', data: { atLocal: EVENT_AT, status: 'scheduled' } }],
      { recurrence: { ...BIRTHDAY }, allDay: true },
    );

    expect((await plain.list(USER))[0].allDay).toBe(false);
    expect((await flagged.list(USER))[0].allDay).toBe(true);
  });

  it('returns nothing when the store is unavailable', async () => {
    const service = new RemindersService({ db: undefined, available: false } as never);

    expect(await service.list(USER)).toEqual([]);
  });
});

/**
 * An in-memory reminder with its notifications, for the Done-closes-the-reminder rules. State lives
 * in plain objects, so the test asserts where every document ends up rather than which calls were
 * made. It answers both the plain document API (`ref.update`, a `where ... in` query) and a
 * transaction (`tx.get` of the reminder or its notifications collection, buffered `tx.update`s
 * applied on commit). `failTransaction` makes the transaction throw before it writes anything.
 */
function fakeReminderTree(
  reminderData: Record<string, unknown>,
  notificationDocs: { id: string; data: Record<string, unknown> }[],
  options: { failTransaction?: boolean } = {},
) {
  const reminder = { ...reminderData };
  const stored = new Map(notificationDocs.map((doc) => [doc.id, { ...doc.data }]));

  const snapshotOf = (id: string) => ({
    id,
    exists: stored.has(id),
    ref: notificationRef(id),
    data: () => stored.get(id),
    get: (field: string) => stored.get(id)?.[field],
  });
  const querySnapshot = (ids: string[]) => {
    const docs = ids.map(snapshotOf);
    return { docs, empty: docs.length === 0, size: docs.length };
  };

  const notifications = {
    kind: 'notifications',
    get: async () => querySnapshot([...stored.keys()]),
    doc: (id: string) => notificationRef(id),
    where: (field: string, op: string, value: unknown) => {
      expect(op).toBe('in');
      const matching = () =>
        [...stored.keys()].filter((id) => (value as unknown[]).includes(stored.get(id)?.[field]));
      return {
        get: async () => querySnapshot(matching()),
        limit: (n: number) => ({ get: async () => querySnapshot(matching().slice(0, n)) }),
      };
    },
  };

  const reminderRef: Record<string, unknown> = {
    id: 'reminder-1',
    kind: 'reminder',
    collection: (name: string) => {
      expect(name).toBe(NOTIFICATIONS);
      return notifications;
    },
    update: async (data: Record<string, unknown>) => void Object.assign(reminder, data),
  };

  function notificationRef(id: string): Record<string, unknown> {
    return {
      id,
      kind: 'notification',
      parent: { parent: reminderRef },
      update: async (data: Record<string, unknown>) => {
        if (!stored.has(id)) {
          throw new Error(`no notification ${id}`);
        }
        Object.assign(stored.get(id) as Record<string, unknown>, data);
      },
    };
  }

  const db = {
    runTransaction: async <T>(
      body: (tx: {
        get: (target: unknown) => Promise<unknown>;
        update: (ref: unknown, data: Record<string, unknown>) => void;
      }) => Promise<T>,
    ): Promise<T> => {
      if (options.failTransaction) {
        throw new Error('firestore unavailable');
      }
      const pending: { ref: Record<string, unknown>; data: Record<string, unknown> }[] = [];
      const result = await body({
        get: async (target) => {
          const kind = (target as { kind?: string }).kind;
          if (kind === 'reminder') {
            return { id: 'reminder-1', exists: true, data: () => reminder, get: (f: string) => reminder[f] };
          }
          if (kind === 'notifications') {
            return querySnapshot([...stored.keys()]);
          }
          throw new Error(`unexpected transaction read of ${kind}`);
        },
        update: (ref, data) => void pending.push({ ref: ref as Record<string, unknown>, data }),
      });
      for (const write of pending) {
        await (write.ref.update as (data: Record<string, unknown>) => Promise<void>)(write.data);
      }
      return result;
    },
  };

  return {
    reminder,
    status: (id: string) => stored.get(id)?.status,
    doc: (id: string) => stored.get(id),
    ref: (id: string) => notificationRef(id),
    service: new RemindersService({ db, available: true } as never),
  };
}

const ONE_OFF = { status: 'scheduled', title: 'dentist', eventAt: '2026-12-10T14:00:00+02:00' };

describe('RemindersService.ackNotification', () => {
  const ACK_NOW = new Date('2026-10-14T14:05:00+03:00');
  const ACKED = { status: 'acked', ackedAt: Timestamp.fromDate(ACK_NOW) };

  // 0023 acceptance: done-removes-from-digest - the only notification acked closes the reminder
  it('closes the reminder when its only notification is acked', async () => {
    const store = fakeReminderTree(ONE_OFF, [{ id: 'only', data: { status: 'sent' } }]);

    await store.service.ackNotification(store.ref('only') as never, USER, ACK_NOW);

    expect(store.doc('only')).toEqual(ACKED);
    expect(store.reminder).toMatchObject(ACKED);
  });

  it('closes the reminder once every notification is done', async () => {
    const store = fakeReminderTree(ONE_OFF, [
      { id: 'first', data: { status: 'acked' } },
      { id: 'second', data: { status: 'sent' } },
    ]);

    await store.service.ackNotification(store.ref('second') as never, USER, ACK_NOW);

    expect(store.reminder.status).toBe('acked');
    expect(store.status('first')).toBe('acked');
  });

  // The tap is already recorded on the notification; a failed close must not surface as an error,
  // and - the close and the cancel being one transaction - nothing else is half-written.
  it('does not throw when closing the reminder fails, and leaves the rest untouched', async () => {
    const store = fakeReminderTree(
      ONE_OFF,
      [
        { id: 'first', data: { status: 'sent' } },
        { id: 'second', data: { status: 'scheduled' } },
      ],
      { failTransaction: true },
    );

    await expect(
      store.service.ackNotification(store.ref('first') as never, USER, ACK_NOW),
    ).resolves.toBeUndefined();
    expect(store.status('first')).toBe('acked');
    expect(store.status('second')).toBe('scheduled');
    expect(store.reminder.status).toBe('scheduled');
  });
});

describe('RemindersService.ackNotification on a reminder with several nudges (BUG-0004)', () => {
  const ACK_NOW = new Date('2026-12-10T09:05:00+02:00');

  // BUG-0004 acceptance: unit-regression / repro-fixed - the evening-before nudge was delivered and
  // never tapped, then Done on the morning-of nudge. The ignored one must not keep the reminder open.
  it('closes a one-off reminder when an earlier nudge was left sent', async () => {
    const store = fakeReminderTree(ONE_OFF, [
      { id: 'evening', data: { status: 'sent', userId: USER } },
      { id: 'morning', data: { status: 'sent', userId: USER } },
    ]);

    await store.service.ackNotification(store.ref('morning') as never, USER, ACK_NOW);

    expect(store.reminder.status).toBe('acked');
    expect(store.status('morning')).toBe('acked');
    expect(store.status('evening')).toBe('acked');
  });

  // BUG-0004 acceptance: later-nudge-cancelled - Done on the first nudge closes the reminder and
  // cancels the one still to come, so no notification of it is left for the sweep's findDue.
  it('cancels a one-off reminder\'s nudges that have not fired yet', async () => {
    const store = fakeReminderTree(ONE_OFF, [
      { id: 'evening', data: { status: 'sent' } },
      { id: 'morning', data: { status: 'scheduled' } },
    ]);

    await store.service.ackNotification(store.ref('evening') as never, USER, ACK_NOW);

    expect(store.reminder.status).toBe('acked');
    expect(store.status('evening')).toBe('acked');
    expect(store.doc('morning')).toEqual({
      status: 'cancelled',
      cancelledAt: Timestamp.fromDate(ACK_NOW),
    });
  });

  // A nudge given up after failed sends (BUG-0003) is finished; it neither blocks nor is rewritten.
  it('closes a one-off reminder past a failed nudge and leaves that nudge failed', async () => {
    const store = fakeReminderTree(ONE_OFF, [
      { id: 'evening', data: { status: 'failed', sendAttempts: 3 } },
      { id: 'morning', data: { status: 'sent' } },
    ]);

    await store.service.ackNotification(store.ref('morning') as never, USER, ACK_NOW);

    expect(store.reminder.status).toBe('acked');
    expect(store.doc('evening')).toEqual({ status: 'failed', sendAttempts: 3 });
  });

  it('leaves already-finished nudges of a one-off as they were', async () => {
    const store = fakeReminderTree(ONE_OFF, [
      { id: 'evening', data: { status: 'cancelled' } },
      { id: 'noon', data: { status: 'acked', ackedAt: 'earlier' } },
      { id: 'morning', data: { status: 'sent' } },
    ]);

    await store.service.ackNotification(store.ref('morning') as never, USER, ACK_NOW);

    expect(store.doc('evening')).toEqual({ status: 'cancelled' });
    expect(store.doc('noon')).toEqual({ status: 'acked', ackedAt: 'earlier' });
  });

  // 0023 acceptance: recurring-done-keeps-reminder / BUG-0004 recurring-unchanged - only the tapped
  // occurrence is acked; the reminder stays open and the next occurrence stays armed.
  it('does not close a recurring reminder whose next occurrence is armed', async () => {
    const DAILY = { freq: 'daily', atLocal: '15:00', timezone: 'Europe/Kyiv' };
    const store = fakeReminderTree({ status: 'scheduled', recurrence: DAILY }, [
      { id: 'today', data: { status: 'sent', recurrence: DAILY } },
      { id: 'tomorrow', data: { status: 'scheduled', recurrence: DAILY } },
    ]);

    await store.service.ackNotification(store.ref('today') as never, USER, ACK_NOW);

    expect(store.status('today')).toBe('acked');
    expect(store.reminder.status).toBe('scheduled');
    expect(store.doc('tomorrow')).toEqual({ status: 'scheduled', recurrence: DAILY });
  });

  // Recurring keeps the earlier rule exactly: an earlier occurrence left sent still holds it open.
  it('does not ack the other delivered occurrences of a recurring reminder', async () => {
    const store = fakeReminderTree({ status: 'scheduled', recurrence: BIRTHDAY }, [
      { id: 'last-year', data: { status: 'sent', recurrence: BIRTHDAY } },
      { id: 'this-year', data: { status: 'sent', recurrence: BIRTHDAY } },
    ]);

    await store.service.ackNotification(store.ref('this-year') as never, USER, ACK_NOW);

    expect(store.status('last-year')).toBe('sent');
    expect(store.reminder.status).toBe('scheduled');
  });

  it('treats a reminder as recurring when only its notifications carry the rule', async () => {
    const store = fakeReminderTree({ status: 'scheduled' }, [
      { id: 'today', data: { status: 'sent', recurrence: BIRTHDAY } },
      { id: 'next', data: { status: 'scheduled', recurrence: BIRTHDAY } },
    ]);

    await store.service.ackNotification(store.ref('today') as never, USER, ACK_NOW);

    expect(store.status('next')).toBe('scheduled');
    expect(store.reminder.status).toBe('scheduled');
  });
});
