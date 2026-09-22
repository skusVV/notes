import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same stub as the command spec: no outbound call reaches api.telegram.org.
vi.mock('axios', () => {
  const instance = {
    post: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: Buffer.alloc(0) }),
  };
  return { default: { create: vi.fn(() => instance) }, create: vi.fn(() => instance) };
});

import { ClockService } from '../src/clock/clock.service';
import { parseCallbackData, reminderKeyboard, TelegramService } from '../src/telegram/telegram.service';
import { TelegramUpdate } from '../src/telegram/telegram.types';

const OWNER = 555111;
const STRANGER = 999222;
// The delivered nudge the buttons act on, and a second nudge of the SAME reminder that must not move.
const NOTIFICATION_ID = 'abcdefGHIJ0123456789';
const OTHER_NOTIFICATION_ID = 'zyxwvUTSRQ9876543210';
const NOTIFICATION_REF = { id: NOTIFICATION_ID } as never;

/**
 * A reminders stub whose lookup only ever finds OWNER's notification, like the real user-scoped
 * path does, and which hands back the document reference the button branches act on.
 */
function fakeReminders(recurring = false) {
  return {
    available: true,
    getOwnedNotification: vi.fn(async (userId: number, id: string) =>
      userId === OWNER && id === NOTIFICATION_ID
        ? { id, ref: NOTIFICATION_REF, userId, status: 'sent', recurring }
        : undefined,
    ),
    ackNotification: vi.fn().mockResolvedValue(undefined),
    snoozeNotification: vi.fn().mockResolvedValue(undefined),
  };
}

function makeService(reminders: ReturnType<typeof fakeReminders>, allowedUsers?: string) {
  const config = {
    get: (key: string): string | undefined => {
      if (key === 'TELEGRAM_BOT_TOKEN') return 'fake:token';
      if (key === 'ALLOWED_USERS') return allowedUsers;
      return undefined;
    },
  };
  const transcription = { available: false };
  const classifier = { available: false, defaultTimezone: 'Europe/Kyiv' };

  // The callback path never touches actors or notes, so an unavailable one is enough.
  const actors = { available: false };
  const notes = { available: false };

  return new TelegramService(
    config as never,
    transcription as never,
    classifier as never,
    reminders as never,
    actors as never,
    notes as never,
    new ClockService(),
  );
}

function tap(action: string, from: number, id = NOTIFICATION_ID): TelegramUpdate {
  return {
    update_id: 7,
    callback_query: {
      id: 'cbq-1',
      from: { id: from, is_bot: false },
      message: { message_id: 3, chat: { id: from } },
      data: `rem:${action}:${id}`,
    },
  };
}

describe('parseCallbackData', () => {
  // acceptance: callback-ok-acks / callback-snooze-1h / callback-tomorrow - data parsing
  it('accepts the three delivery actions', () => {
    for (const action of ['ok', '1h', 'tmrw'] as const) {
      expect(parseCallbackData(`rem:${action}:${NOTIFICATION_ID}`)).toEqual({
        action,
        id: NOTIFICATION_ID,
      });
    }
  });

  it('rejects anything that is not one of this feature\'s buttons', () => {
    for (const bad of [
      undefined,
      '',
      'rem',
      'rem:ok',
      `rem:ok:${NOTIFICATION_ID}:extra`,
      `rem:nope:${NOTIFICATION_ID}`,
      `rem:OK:${NOTIFICATION_ID}`,
      `other:ok:${NOTIFICATION_ID}`,
      'rem:ok:',
    ]) {
      expect(parseCallbackData(bad)).toBeUndefined();
    }
  });
});

describe('reminderKeyboard', () => {
  it('offers the three buttons, each well under Telegram\'s 64-byte callback_data limit', () => {
    const [row] = reminderKeyboard(NOTIFICATION_ID).inline_keyboard;

    expect(row.map((button) => button.callback_data)).toEqual([
      `rem:ok:${NOTIFICATION_ID}`,
      `rem:1h:${NOTIFICATION_ID}`,
      `rem:tmrw:${NOTIFICATION_ID}`,
    ]);
    for (const button of row) {
      expect(Buffer.byteLength(button.callback_data)).toBeLessThan(64);
    }
  });
});

describe('TelegramService callback handling', () => {
  let reminders: ReturnType<typeof fakeReminders>;

  beforeEach(() => {
    reminders = fakeReminders();
  });

  // acceptance: ok-acks-only-that-notification - OK acts on the tapped notification's own
  // document, so no other notification of the same reminder is touched and no time moves
  it('acks exactly the tapped notification on OK, moving no time', async () => {
    const service = makeService(reminders);

    await service.handleUpdate(tap('ok', OWNER), [], '2026-09-16T10:05:00+03:00');

    expect(reminders.ackNotification).toHaveBeenCalledWith(
      NOTIFICATION_REF,
      OWNER,
      expect.any(Date),
    );
    expect(reminders.snoozeNotification).not.toHaveBeenCalled();
  });

  // acceptance: snooze-moves-only-that-notification - that notification's `at` becomes tap + 1h
  it('reschedules the tapped notification to tap + 1h on +1h', async () => {
    const service = makeService(reminders);

    await service.handleUpdate(tap('1h', OWNER), [], '2026-09-21T19:05:00+03:00');

    expect(reminders.snoozeNotification).toHaveBeenCalledWith(
      NOTIFICATION_REF,
      OWNER,
      new Date('2026-09-21T20:05:00+03:00'),
      '2026-09-21T20:05:00+03:00',
      false,
    );
    expect(reminders.ackNotification).not.toHaveBeenCalled();
  });

  // A snooze on a recurring reminder's occurrence must not hand it a TTL field: the last argument
  // is what keeps a recurring notification exempt from the expireAt policy. The recurrence itself
  // is untouched - the following occurrence is already scheduled.
  it('tells the store not to add an expiry when the notification is recurring', async () => {
    const recurring = fakeReminders(true);
    const service = makeService(recurring);

    await service.handleUpdate(tap('1h', OWNER), [], '2027-06-12T09:05:00+03:00');

    expect(recurring.snoozeNotification).toHaveBeenCalledWith(
      NOTIFICATION_REF,
      OWNER,
      new Date('2027-06-12T10:05:00+03:00'),
      '2027-06-12T10:05:00+03:00',
      true,
    );
  });

  // acceptance: snooze-moves-only-that-notification - next calendar day at 09:00 local
  it('reschedules the tapped notification to the next local day at 09:00 on Tomorrow', async () => {
    const service = makeService(reminders);

    await service.handleUpdate(tap('tmrw', OWNER), [], '2026-09-16T22:00:00+03:00');

    expect(reminders.snoozeNotification).toHaveBeenCalledWith(
      NOTIFICATION_REF,
      OWNER,
      new Date('2026-09-17T09:00:00+03:00'),
      '2026-09-17T09:00:00+03:00',
      false,
    );
  });

  // acceptance: ok-acks-only-that-notification / snooze-moves-only-that-notification - a tap
  // carrying another notification's id is not the delivered one, so the delivered one stays put
  it('never acts on a notification other than the one whose button was tapped', async () => {
    const service = makeService(reminders);

    await service.handleUpdate(
      tap('ok', OWNER, OTHER_NOTIFICATION_ID),
      [],
      '2026-09-16T10:05:00+03:00',
    );

    expect(reminders.getOwnedNotification).toHaveBeenCalledWith(OWNER, OTHER_NOTIFICATION_ID);
    expect(reminders.ackNotification).not.toHaveBeenCalled();
    expect(reminders.snoozeNotification).not.toHaveBeenCalled();
  });

  // acceptance: callback-not-owner - a tap from anyone else changes nothing
  it('refuses a tap from a user who does not own the notification', async () => {
    const service = makeService(reminders);
    const replies: string[] = [];

    await service.handleUpdate(tap('ok', STRANGER), replies, '2026-09-16T10:05:00+03:00');

    expect(reminders.getOwnedNotification).toHaveBeenCalledWith(STRANGER, NOTIFICATION_ID);
    expect(reminders.ackNotification).not.toHaveBeenCalled();
    expect(reminders.snoozeNotification).not.toHaveBeenCalled();
    // The spinner is still stopped, so the tap does not hang.
    expect(replies).toHaveLength(1);
  });

  it('runs the ALLOWED_USERS gate before it touches the store at all', async () => {
    const service = makeService(reminders, String(OWNER));

    await service.handleUpdate(tap('ok', STRANGER), [], '2026-09-16T10:05:00+03:00');

    expect(reminders.getOwnedNotification).not.toHaveBeenCalled();
    expect(reminders.ackNotification).not.toHaveBeenCalled();
  });

  it('refuses an unrecognised button without reading the store', async () => {
    const service = makeService(reminders);
    const update = tap('ok', OWNER);
    update.callback_query!.data = 'something:else';

    await service.handleUpdate(update, [], '2026-09-16T10:05:00+03:00');

    expect(reminders.getOwnedNotification).not.toHaveBeenCalled();
  });

  it('answers the tap even when the store throws', async () => {
    const service = makeService(reminders);
    reminders.getOwnedNotification.mockRejectedValueOnce(new Error('firestore is down'));
    const replies: string[] = [];

    await expect(
      service.handleUpdate(tap('ok', OWNER), replies, '2026-09-16T10:05:00+03:00'),
    ).resolves.toBeUndefined();
    expect(replies).toHaveLength(1);
  });
});
