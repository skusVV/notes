import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep every outbound Telegram call off the network.
const http = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));
vi.mock('axios', () => ({
  default: { create: vi.fn(() => http) },
  create: vi.fn(() => http),
}));

import { ClockService } from '../src/clock/clock.service';
import { parseDigestCommand, TelegramService } from '../src/telegram/telegram.service';
import { TelegramUpdate } from '../src/telegram/telegram.types';
import { fakeDigestStore } from './fake-digest-store';

const U1 = 900000001;
const U2 = 900000002;

function makeService(seed: Record<string, Record<string, unknown>> = {}) {
  const store = fakeDigestStore(seed);
  const config = {
    get: (key: string): string | undefined =>
      ({ TELEGRAM_BOT_TOKEN: 'fake:token', ALLOWED_USERS: `${U1},${U2}` })[key],
  };
  const off = { available: false } as never;
  const service = new TelegramService(
    config as never,
    off,
    off,
    off,
    off,
    off,
    off,
    new ClockService(),
    store.settings,
  );
  return { service, store };
}

function textUpdate(text: string, from = U1): TelegramUpdate {
  return {
    update_id: 1,
    message: { message_id: 1, chat: { id: from }, from: { id: from, is_bot: false }, text },
  };
}

async function send(service: TelegramService, text: string, from = U1): Promise<string[]> {
  const replies: string[] = [];
  await service.handleUpdate(textUpdate(text, from), replies);
  return replies;
}

async function exportedDigest(service: TelegramService, from = U1): Promise<unknown> {
  const [json] = await send(service, '/export', from);
  return (JSON.parse(json) as { digest: unknown }).digest;
}

beforeEach(() => {
  http.post.mockReset().mockResolvedValue({ data: {} });
  http.get.mockReset().mockResolvedValue({ data: Buffer.alloc(0) });
});

describe('parseDigestCommand', () => {
  it('parses on, off and the bare status form', () => {
    expect(parseDigestCommand('/digest on')).toBe('on');
    expect(parseDigestCommand('/digest off')).toBe('off');
    expect(parseDigestCommand('/digest')).toBe('status');
    expect(parseDigestCommand('  /digest   ')).toBe('status');
    expect(parseDigestCommand('/digest ON')).toBe('on');
    expect(parseDigestCommand('/digest@notes_bot off')).toBe('off');
  });

  it('refuses a time, junk and extra arguments', () => {
    for (const text of [
      '/digest 08:30',
      '/digest maybe',
      '/digest on now',
      '/digest on off',
      '/digest 1',
      '/digests on',
    ]) {
      expect(parseDigestCommand(text)).toBe('invalid');
    }
  });
});

describe('/digest command', () => {
  it('status, on, status, off - exact replies and stored state', async () => {
    const { service, store } = makeService();

    expect(await send(service, '/digest')).toEqual(['Ранковий звіт: вимкнено.']);

    expect(await send(service, '/digest on')).toEqual(['Ранковий звіт увімкнено.']);
    expect(await exportedDigest(service)).toEqual({ enabled: true, lastSentOn: null });
    expect(store.docs.get(`users/${U1}`)).toEqual({ digest: { enabled: true, chatId: U1 } });

    expect(await send(service, '/digest')).toEqual(['Ранковий звіт: увімкнено.']);

    expect(await send(service, '/digest off')).toEqual(['Ранковий звіт вимкнено.']);
    expect(await exportedDigest(service)).toEqual({ enabled: false, lastSentOn: null });
  });

  it('a bad argument changes nothing and /export keeps digest null', async () => {
    const { service, store } = makeService();

    expect(await exportedDigest(service, U2)).toBeNull();
    expect(await send(service, '/digest 08:30', U2)).toEqual([
      'Не зрозумів. Команди: /digest on, /digest off',
    ]);
    expect(await send(service, '/digest whatever', U2)).toEqual([
      'Не зрозумів. Команди: /digest on, /digest off',
    ]);
    expect(await exportedDigest(service, U2)).toBeNull();
    expect(store.docs.has(`users/${U2}`)).toBe(false);
  });

  it('on/off leaves lastSentOn and other user fields alone', async () => {
    const { service, store } = makeService({
      [`users/${U1}`]: {
        declinedMentions: ['bob'],
        digest: { enabled: true, chatId: U1, lastSentOn: '2026-09-16' },
      },
    });

    await send(service, '/digest off');
    await send(service, '/digest on');

    expect(store.docs.get(`users/${U1}`)).toEqual({
      declinedMentions: ['bob'],
      digest: { enabled: true, chatId: U1, lastSentOn: '2026-09-16' },
    });
    expect(await exportedDigest(service)).toEqual({ enabled: true, lastSentOn: '2026-09-16' });
  });

  it('is behind ALLOWED_USERS like every other command', async () => {
    const { service, store } = makeService();

    expect(await send(service, '/digest on', 900000007)).toEqual([
      'Sorry, you are not allowed to use this bot.',
    ]);
    expect(store.docs.size).toBe(0);
  });

  it('is listed in /help', async () => {
    const { service } = makeService();
    const [help] = await send(service, '/help');
    expect(help).toContain('/digest on');
  });
});
