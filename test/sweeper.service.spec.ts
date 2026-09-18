import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Recurrence } from '../src/reminders/recurrence';
import { DueNotification } from '../src/reminders/reminders.service';
import { DEFAULT_SWEEP_INTERVAL_MINUTES, SweeperService } from '../src/telegram/sweeper.service';

const NOW = new Date('2026-09-16T09:45:00+03:00');

const BIRTHDAY: Recurrence = {
  freq: 'yearly',
  month: 6,
  day: 12,
  atLocal: '09:00',
  timezone: 'Europe/Kyiv',
};

interface StoredNotification {
  id: string;
  at: Date;
  status: string;
  /** Present for a recurring reminder's single occurrence. */
  recurrence?: Recurrence;
  atLocal?: string;
}

/** Minutes after NOW, as an instant. */
function ahead(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

/**
 * An in-memory stand-in for RemindersService that applies the same rules the Firestore query and
 * the claim transaction do: `findDue` matches only `scheduled` notifications at or before the
 * cutoff, and `claimForSend` flips `scheduled -> sent` exactly once - per notification, so two
 * nudges of one reminder are independent.
 */
function fakeReminders(store: StoredNotification[]) {
  return {
    available: true,
    findDue: vi.fn(async (cutoff: Date): Promise<DueNotification[]> =>
      store
        .filter((n) => n.status === 'scheduled' && n.at.getTime() <= cutoff.getTime())
        .map((n) => ({
          id: n.id,
          ref: { id: n.id } as never,
          reminderId: 'reminder-1',
          userId: 1,
          chatId: 1,
          title: 'something',
          eventAt: '2026-09-16T10:00:00+03:00',
          atLocal: n.atLocal ?? '2026-09-16T10:00:00+03:00',
          recurrence: n.recurrence,
        })),
    ),
    backfillLegacy: vi.fn(async (): Promise<number> => 0),
    // Stands in for the transactional guard: it arms an occurrence only while the reminder has
    // none scheduled, which is what makes a retried tick harmless.
    enqueueNextOccurrence: vi.fn(async (notification: DueNotification): Promise<string | undefined> => {
      if (store.some((n) => n.status === 'scheduled')) {
        return undefined;
      }
      const next: StoredNotification = {
        id: `${notification.id}-next`,
        at: new Date('2028-06-12T09:00:00+03:00'),
        atLocal: '2028-06-12T09:00:00+03:00',
        status: 'scheduled',
        recurrence: notification.recurrence,
      };
      store.push(next);
      return next.atLocal;
    }),
    claimForSend: vi.fn(async (ref: { id: string }): Promise<boolean> => {
      const found = store.find((n) => n.id === ref.id);
      if (!found || found.status !== 'scheduled') {
        return false;
      }
      found.status = 'sent';
      return true;
    }),
  };
}

function makeSweeper(store: StoredNotification[], interval?: string) {
  const config = {
    get: (key: string): string | undefined =>
      key === 'REMINDER_SWEEP_INTERVAL_MINUTES'
        ? interval
        : key === 'REMINDER_SWEEP_SECRET'
          ? 'sweepsecret'
          : undefined,
  };
  const reminders = fakeReminders(store);
  const telegram = { sendReminder: vi.fn().mockResolvedValue(undefined) };

  const sweeper = new SweeperService(config as never, reminders as never, telegram as never);
  return { sweeper, reminders, telegram };
}

describe('SweeperService cutoff', () => {
  // acceptance: due-delivered / not-yet-due - the look-ahead horizon is now + interval
  it('reaches exactly one interval past now', () => {
    const { sweeper } = makeSweeper([]);

    expect(sweeper.intervalMinutes).toBe(DEFAULT_SWEEP_INTERVAL_MINUTES);
    expect(sweeper.cutoff(NOW).getTime()).toBe(NOW.getTime() + 30 * 60_000);
  });

  it('honours REMINDER_SWEEP_INTERVAL_MINUTES', () => {
    expect(makeSweeper([], '10').sweeper.cutoff(NOW).getTime()).toBe(NOW.getTime() + 10 * 60_000);
  });

  it('falls back to the default for an unusable interval', () => {
    for (const bad of ['', '   ', 'soon', '0', '-5', '2.5']) {
      expect(makeSweeper([], bad).sweeper.intervalMinutes).toBe(DEFAULT_SWEEP_INTERVAL_MINUTES);
    }
  });
});

describe('SweeperService.sweep', () => {
  let store: StoredNotification[];

  beforeEach(() => {
    store = [
      { id: 'due-in-15', at: ahead(15), status: 'scheduled' },
      { id: 'due-in-75', at: ahead(75), status: 'scheduled' },
    ];
  });

  // acceptance: independent-delivery - fire early, a notification inside the look-ahead goes out
  // now while the same reminder's later nudge stays scheduled
  it('delivers a notification 15 minutes ahead and leaves one 75 minutes ahead scheduled', async () => {
    const { sweeper, reminders, telegram } = makeSweeper(store);

    const sent = await sweeper.sweep(NOW);

    expect(sent).toBe(1);
    expect(reminders.findDue).toHaveBeenCalledWith(new Date(NOW.getTime() + 30 * 60_000));
    expect(telegram.sendReminder.mock.calls.map((call) => call[0].id)).toEqual(['due-in-15']);
    expect(store.find((n) => n.id === 'due-in-15')?.status).toBe('sent');
    expect(store.find((n) => n.id === 'due-in-75')?.status).toBe('scheduled');
  });

  // acceptance: independent-delivery - the evening-before nudge fires on its own tick, the
  // morning-of nudge of the SAME reminder is still scheduled afterwards and fires on a later tick
  it('delivers the two nudges of one reminder on separate ticks', async () => {
    const eveningBefore = new Date('2026-09-21T19:00:00+03:00');
    const morningOf = new Date('2026-09-22T09:00:00+03:00');
    store = [
      { id: 'evening-before', at: eveningBefore, status: 'scheduled' },
      { id: 'morning-of', at: morningOf, status: 'scheduled' },
    ];
    const { sweeper, telegram } = makeSweeper(store);

    // The tick 15 minutes before the evening nudge.
    expect(await sweeper.sweep(new Date('2026-09-21T18:45:00+03:00'))).toBe(1);
    expect(telegram.sendReminder.mock.calls.map((call) => call[0].id)).toEqual(['evening-before']);
    expect(store.find((n) => n.id === 'morning-of')?.status).toBe('scheduled');

    // The tick before the morning nudge delivers that one, and only that one.
    expect(await sweeper.sweep(new Date('2026-09-22T08:45:00+03:00'))).toBe(1);
    expect(telegram.sendReminder.mock.calls.map((call) => call[0].id)).toEqual([
      'evening-before',
      'morning-of',
    ]);
    expect(store.every((n) => n.status === 'sent')).toBe(true);
  });

  // acceptance: idempotent-no-double-send
  it('does not re-deliver on a second identical sweep', async () => {
    const { sweeper, telegram } = makeSweeper(store);

    await sweeper.sweep(NOW);
    const second = await sweeper.sweep(NOW);

    expect(second).toBe(0);
    expect(telegram.sendReminder).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when it loses the claim to a concurrent tick', async () => {
    const { sweeper, reminders, telegram } = makeSweeper(store);
    reminders.claimForSend.mockResolvedValue(false);

    expect(await sweeper.sweep(NOW)).toBe(0);
    expect(telegram.sendReminder).not.toHaveBeenCalled();
  });

  it('claims before it sends, so a lost race can never notify', async () => {
    const order: string[] = [];
    const { sweeper, reminders, telegram } = makeSweeper(store);
    reminders.claimForSend.mockImplementation(async () => {
      order.push('claim');
      return true;
    });
    telegram.sendReminder.mockImplementation(async () => {
      order.push('send');
    });

    await sweeper.sweep(NOW);

    expect(order).toEqual(['claim', 'send']);
  });

  it('keeps going when one delivery throws', async () => {
    store.push({ id: 'also-due', at: ahead(5), status: 'scheduled' });
    const { sweeper, telegram } = makeSweeper(store);
    telegram.sendReminder.mockRejectedValueOnce(new Error('telegram is down'));

    expect(await sweeper.sweep(NOW)).toBe(1);
    expect(telegram.sendReminder).toHaveBeenCalledTimes(2);
  });

  it('converts legacy single-remindAt reminders before it looks for what is due', async () => {
    const order: string[] = [];
    const { sweeper, reminders } = makeSweeper(store);
    reminders.backfillLegacy.mockImplementation(async () => {
      order.push('backfill');
      return 1;
    });
    reminders.findDue.mockImplementation(async () => {
      order.push('findDue');
      return [];
    });

    await sweeper.sweep(NOW);

    expect(order).toEqual(['backfill', 'findDue']);
  });

  it('still delivers when the backfill throws', async () => {
    const { sweeper, reminders, telegram } = makeSweeper(store);
    reminders.backfillLegacy.mockRejectedValueOnce(new Error('index is building'));

    expect(await sweeper.sweep(NOW)).toBe(1);
    expect(telegram.sendReminder).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the store is unavailable', async () => {
    const { sweeper, reminders, telegram } = makeSweeper(store);
    (reminders as { available: boolean }).available = false;

    expect(await sweeper.sweep(NOW)).toBe(0);
    expect(reminders.findDue).not.toHaveBeenCalled();
    expect(telegram.sendReminder).not.toHaveBeenCalled();
  });

  it('does not try to roll a one-off reminder forward', async () => {
    const { sweeper, reminders } = makeSweeper(store);

    await sweeper.sweep(NOW);

    expect(reminders.enqueueNextOccurrence).not.toHaveBeenCalled();
  });
});

describe('SweeperService.sweep for a recurring reminder', () => {
  /** The birthday's 2027 occurrence, and a tick 10 minutes before it - inside the look-ahead. */
  const FIRED = new Date('2027-06-12T09:00:00+03:00');
  const TICK = new Date('2027-06-12T08:50:00+03:00');

  function recurringStore(): StoredNotification[] {
    return [
      {
        id: 'occurrence-2027',
        at: FIRED,
        atLocal: '2027-06-12T09:00:00+03:00',
        status: 'scheduled',
        recurrence: BIRTHDAY,
      },
    ];
  }

  // acceptance: recurrence-rolls-forward - one delivery, and a NEW scheduled occurrence afterwards
  it('delivers the occurrence and arms the following one', async () => {
    const store = recurringStore();
    const { sweeper, reminders, telegram } = makeSweeper(store);

    expect(await sweeper.sweep(TICK)).toBe(1);
    expect(telegram.sendReminder).toHaveBeenCalledTimes(1);
    expect(reminders.enqueueNextOccurrence).toHaveBeenCalledTimes(1);
    expect(store.find((n) => n.id === 'occurrence-2027')?.status).toBe('sent');
    expect(store.filter((n) => n.status === 'scheduled').map((n) => n.atLocal)).toEqual([
      '2028-06-12T09:00:00+03:00',
    ]);
  });

  // acceptance (unit half): "enqueue exactly one next occurrence" idempotency - a retried tick
  // must not leave two future occurrences, and it must not re-deliver
  it('leaves exactly one scheduled occurrence when the tick is retried', async () => {
    const store = recurringStore();
    const { sweeper, telegram } = makeSweeper(store);

    await sweeper.sweep(TICK);
    expect(await sweeper.sweep(TICK)).toBe(0);

    expect(telegram.sendReminder).toHaveBeenCalledTimes(1);
    expect(store.filter((n) => n.status === 'scheduled')).toHaveLength(1);
  });

  // The recurrence must survive a failed send: the claim already flipped this occurrence to `sent`,
  // so not arming the next one would silently stop the reminder forever.
  it('still arms the next occurrence when the delivery fails', async () => {
    const store = recurringStore();
    const { sweeper, reminders, telegram } = makeSweeper(store);
    telegram.sendReminder.mockRejectedValueOnce(new Error('telegram is down'));

    expect(await sweeper.sweep(TICK)).toBe(0);
    expect(reminders.enqueueNextOccurrence).toHaveBeenCalledTimes(1);
    expect(store.filter((n) => n.status === 'scheduled')).toHaveLength(1);
  });

  it('does not arm anything when it loses the claim', async () => {
    const store = recurringStore();
    const { sweeper, reminders } = makeSweeper(store);
    reminders.claimForSend.mockResolvedValue(false);

    expect(await sweeper.sweep(TICK)).toBe(0);
    expect(reminders.enqueueNextOccurrence).not.toHaveBeenCalled();
  });

  it('keeps delivering when arming the next occurrence throws', async () => {
    const store = recurringStore();
    const { sweeper, reminders, telegram } = makeSweeper(store);
    reminders.enqueueNextOccurrence.mockRejectedValueOnce(new Error('transaction failed'));

    expect(await sweeper.sweep(TICK)).toBe(1);
    expect(telegram.sendReminder).toHaveBeenCalledTimes(1);
  });
});
