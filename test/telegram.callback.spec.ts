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
const REMINDER_ID = 'abcdefGHIJ0123456789';

/** A reminders stub whose subcollection only ever holds OWNER's reminder, like the real path. */
function fakeReminders() {
  return {
    available: true,
    getOwned: vi.fn(async (userId: number, id: string) =>
      userId === OWNER && id === REMINDER_ID
        ? { id, userId, status: 'sent', title: 'take pills' }
        : undefined,
    ),
    ack: vi.fn().mockResolvedValue(undefined),
    snooze: vi.fn().mockResolvedValue(undefined),
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

  return new TelegramService(
    config as never,
    transcription as never,
    classifier as never,
    reminders as never,
    new ClockService(),
  );
}

function tap(action: string, from: number, id = REMINDER_ID): TelegramUpdate {
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
      expect(parseCallbackData(`rem:${action}:${REMINDER_ID}`)).toEqual({
        action,
        id: REMINDER_ID,
      });
    }
  });

  it('rejects anything that is not one of this feature\'s buttons', () => {
    for (const bad of [
      undefined,
      '',
      'rem',
      'rem:ok',
      `rem:ok:${REMINDER_ID}:extra`,
      `rem:nope:${REMINDER_ID}`,
      `rem:OK:${REMINDER_ID}`,
      `other:ok:${REMINDER_ID}`,
      'rem:ok:',
    ]) {
      expect(parseCallbackData(bad)).toBeUndefined();
    }
  });
});

describe('reminderKeyboard', () => {
  it('offers the three buttons, each well under Telegram\'s 64-byte callback_data limit', () => {
    const [row] = reminderKeyboard(REMINDER_ID).inline_keyboard;

    expect(row.map((button) => button.callback_data)).toEqual([
      `rem:ok:${REMINDER_ID}`,
      `rem:1h:${REMINDER_ID}`,
      `rem:tmrw:${REMINDER_ID}`,
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

  // acceptance: callback-ok-acks
  it('acks the owner\'s reminder on OK without moving any time', async () => {
    const service = makeService(reminders);

    await service.handleUpdate(tap('ok', OWNER), [], '2026-09-16T10:05:00+03:00');

    expect(reminders.ack).toHaveBeenCalledWith(OWNER, REMINDER_ID, expect.any(Date));
    expect(reminders.snooze).not.toHaveBeenCalled();
  });

  // acceptance: callback-snooze-1h - remindAt becomes the tap time plus one hour
  it('reschedules to tap + 1h on +1h', async () => {
    const service = makeService(reminders);

    await service.handleUpdate(tap('1h', OWNER), [], '2026-09-16T10:05:00+03:00');

    expect(reminders.snooze).toHaveBeenCalledWith(
      OWNER,
      REMINDER_ID,
      new Date('2026-09-16T11:05:00+03:00'),
    );
    expect(reminders.ack).not.toHaveBeenCalled();
  });

  // acceptance: callback-tomorrow - next calendar day at 09:00 local
  it('reschedules to the next local day at 09:00 on Tomorrow', async () => {
    const service = makeService(reminders);

    await service.handleUpdate(tap('tmrw', OWNER), [], '2026-09-16T22:00:00+03:00');

    expect(reminders.snooze).toHaveBeenCalledWith(
      OWNER,
      REMINDER_ID,
      new Date('2026-09-17T09:00:00+03:00'),
    );
  });

  // acceptance: callback-not-owner - a tap from anyone else changes nothing
  it('refuses a tap from a user who does not own the reminder', async () => {
    const service = makeService(reminders);
    const replies: string[] = [];

    await service.handleUpdate(tap('ok', STRANGER), replies, '2026-09-16T10:05:00+03:00');

    expect(reminders.getOwned).toHaveBeenCalledWith(STRANGER, REMINDER_ID);
    expect(reminders.ack).not.toHaveBeenCalled();
    expect(reminders.snooze).not.toHaveBeenCalled();
    // The spinner is still stopped, so the tap does not hang.
    expect(replies).toHaveLength(1);
  });

  it('runs the ALLOWED_USERS gate before it touches the store at all', async () => {
    const service = makeService(reminders, String(OWNER));

    await service.handleUpdate(tap('ok', STRANGER), [], '2026-09-16T10:05:00+03:00');

    expect(reminders.getOwned).not.toHaveBeenCalled();
    expect(reminders.ack).not.toHaveBeenCalled();
  });

  it('refuses an unrecognised button without reading the store', async () => {
    const service = makeService(reminders);
    const update = tap('ok', OWNER);
    update.callback_query!.data = 'something:else';

    await service.handleUpdate(update, [], '2026-09-16T10:05:00+03:00');

    expect(reminders.getOwned).not.toHaveBeenCalled();
  });

  it('answers the tap even when the store throws', async () => {
    const service = makeService(reminders);
    reminders.getOwned.mockRejectedValueOnce(new Error('firestore is down'));
    const replies: string[] = [];

    await expect(
      service.handleUpdate(tap('ok', OWNER), replies, '2026-09-16T10:05:00+03:00'),
    ).resolves.toBeUndefined();
    expect(replies).toHaveLength(1);
  });
});
