import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep every outbound Telegram call off the network: axios.create returns a stub whose post
// resolves, so the command handlers run to completion without touching api.telegram.org.
vi.mock('axios', () => {
  const instance = {
    post: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: Buffer.alloc(0) }),
  };
  return { default: { create: vi.fn(() => instance) }, create: vi.fn(() => instance) };
});

import { ClockService } from '../src/clock/clock.service';
import { TelegramService } from '../src/telegram/telegram.service';
import { TelegramUpdate } from '../src/telegram/telegram.types';

// The version the /version reply must echo, read from the same package.json the service reads.
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
).version;

/**
 * Build a TelegramService with the model boundaries stubbed. The command path never calls the
 * transcription or classifier services, so `available: false` is enough; ALLOWED_USERS is left
 * unset, which allows every sender.
 */
function makeService(): TelegramService {
  const config = {
    get: (key: string): string | undefined =>
      key === 'TELEGRAM_BOT_TOKEN' ? 'fake:token' : undefined,
  };
  const transcription = { available: false } as unknown;
  const classifier = { available: false } as unknown;
  const reminders = { available: false } as unknown;
  const actors = { available: false } as unknown;
  const notes = { available: false } as unknown;
  const symptoms = { available: false } as unknown;
  const clock = new ClockService();

  return new TelegramService(
    config as never,
    transcription as never,
    classifier as never,
    reminders as never,
    actors as never,
    notes as never,
    symptoms as never,
    clock,
    { available: false } as never,
  );
}

/** A minimal text-message update from an allowed sender. */
function textUpdate(text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 42 },
      from: { id: 777888, is_bot: false, username: 'someone' },
      text,
    },
  };
}

describe('TelegramService command routing', () => {
  let service: TelegramService;

  beforeEach(() => {
    service = makeService();
  });

  // acceptance: version-format
  it('replies to /version with "notes-bot <semver>"', async () => {
    const replies: string[] = [];
    await service.handleUpdate(textUpdate('/version'), replies);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/^notes-bot \d+\.\d+\.\d+$/);
    expect(replies[0]).toBe(`notes-bot ${PACKAGE_VERSION}`);
  });

  it('handles /version with a trailing @botname and arguments', async () => {
    const replies: string[] = [];
    await service.handleUpdate(textUpdate('/version@notes_bot now'), replies);

    expect(replies).toEqual([`notes-bot ${PACKAGE_VERSION}`]);
  });

  // acceptance: unknown-command-unchanged
  it('leaves the unknown-command fallthrough intact for /nope', async () => {
    const replies: string[] = [];
    await service.handleUpdate(textUpdate('/nope'), replies);

    expect(replies).toEqual(['I do not know /nope. Try /help.']);
  });

  it('still answers /help without treating it as a version request', async () => {
    const replies: string[] = [];
    await service.handleUpdate(textUpdate('/help'), replies);

    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toMatch(/^notes-bot /);
    expect(replies[0]).toContain('/help - this message');
  });
});

// BUG-0007: an all-day one-off is confirmed and delivered as a day, never with its 23:59 sentinel.
describe('TelegramService all-day one-off reminder (BUG-0007)', () => {
  const NOW = '2026-11-25T16:18:00+02:00';
  const ALL_DAY_AT = '2026-11-28T23:59:00+02:00';

  function makeReminderService(reminder: Record<string, unknown>) {
    const config = {
      get: (key: string): string | undefined =>
        key === 'TELEGRAM_BOT_TOKEN' ? 'fake:token' : undefined,
    };
    const classify = vi.fn().mockResolvedValue({
      items: [{ intent: 'reminder', confidence: 0.95, summary: 'a reminder', reminder }],
      language: 'uk',
      mentions: [],
      keywords: [],
    });
    const classifier = { available: true, defaultTimezone: 'Europe/Kyiv', classify };
    const reminders = { available: true, create: vi.fn().mockResolvedValue('reminder-1') };

    const service = new TelegramService(
      config as never,
      { available: false } as never,
      classifier as never,
      reminders as never,
      { available: false } as never,
      { available: false } as never,
      { available: false } as never,
      new ClockService(),
      { available: false } as never,
    );
    return { service, reminders };
  }

  // acceptance: repro-fixed / day-only-with-nudge - the day, then the nudges, no clock time for the event
  it('confirms the day and the resolved nudges, without the 23:59 sentinel', async () => {
    const { service, reminders } = makeReminderService({
      title: 'здати аналізи',
      eventAt: ALL_DAY_AT,
      notifyAt: ['evening_before', '2026-11-28T06:00:00+02:00'],
      allDay: true,
    });
    const replies: string[] = [];

    await service.handleUpdate(textUpdate('В суботу вранці я йду здавати аналізи'), replies, NOW);

    expect(reminders.create.mock.calls[0][2]).toMatchObject({ eventAt: ALL_DAY_AT, allDay: true });
    expect(replies[0]).toBe(
      [
        'Нагадування збережено: здати аналізи',
        '28 листопада',
        'Нагадаю: післязавтра о 19:00, 28 листопада о 6:00',
      ].join('\n'),
    );
    expect(replies.join('\n')).not.toContain('23:59');
    expect(replies.join('\n')).not.toContain('(0.49)');
  });

  // No regression: a timed one-off keeps its existing confirmation, with no nudge line.
  it('leaves the confirmation of a timed reminder unchanged', async () => {
    const { service } = makeReminderService({
      title: 'вечеря',
      eventAt: '2026-11-27T20:00:00+02:00',
      notifyAt: ['evening_before'],
    });
    const replies: string[] = [];

    await service.handleUpdate(textUpdate('вечеря'), replies, NOW);

    expect(replies[0]).toBe('Нагадування збережено: вечеря\nПіслязавтра о 20:00');
  });

  // The delivery of an all-day notification names the day only.
  it('delivers an all-day notification with the day and no clock time', async () => {
    const { service } = makeReminderService({ title: 'x' });
    const sink: string[] = [];

    await service.sendReminder(
      {
        id: 'n1',
        ref: {} as never,
        reminderId: 'reminder-1',
        userId: 777888,
        chatId: 42,
        title: 'здати аналізи',
        eventAt: ALL_DAY_AT,
        atLocal: '2026-11-27T19:00:00+02:00',
        allDay: true,
      } as never,
      new Date('2026-11-27T19:00:00+02:00'),
      sink,
    );

    expect(sink).toEqual(['Нагадування: здати аналізи\nЗавтра']);
  });

  // No regression: a timed notification keeps its clock time.
  it('delivers a timed notification with its clock time', async () => {
    const { service } = makeReminderService({ title: 'x' });
    const sink: string[] = [];

    await service.sendReminder(
      {
        id: 'n1',
        ref: {} as never,
        reminderId: 'reminder-1',
        userId: 777888,
        chatId: 42,
        title: 'вечеря',
        eventAt: '2026-11-27T20:00:00+02:00',
        atLocal: '2026-11-26T19:00:00+02:00',
      } as never,
      new Date('2026-11-26T19:00:00+02:00'),
      sink,
    );

    expect(sink).toEqual(['Нагадування: вечеря\nЗавтра о 20:00']);
  });
});
