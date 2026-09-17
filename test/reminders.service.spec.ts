import { Timestamp } from '@google-cloud/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { NOTIFICATIONS, RemindersService } from '../src/reminders/reminders.service';

const USER = 900000001;
const CHAT = 900000001;
const NOW = new Date('2026-09-16T09:00:00+03:00');
const EVENT_AT = '2026-09-22T14:00:00+03:00';

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

/** A read-only fake holding one reminder document and the notification documents under it. */
function fakeStore(notificationDocs: { id: string; data: Record<string, unknown> }[]) {
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

  it('returns nothing when the store is unavailable', async () => {
    const service = new RemindersService({ db: undefined, available: false } as never);

    expect(await service.list(USER)).toEqual([]);
  });
});
