import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep every outbound Telegram call off the network, as in telegram.service.spec.ts.
vi.mock('axios', () => {
  const instance = {
    post: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: Buffer.alloc(0) }),
  };
  return { default: { create: vi.fn(() => instance) }, create: vi.fn(() => instance) };
});

import { ClockService } from '../src/clock/clock.service';
import { INGEST_MAX_TEXT_CHARS, IngestController } from '../src/ingest/ingest.controller';
import { IngestGuard } from '../src/ingest/ingest.guard';
import { TelegramService } from '../src/telegram/telegram.service';
import { TelegramUpdate } from '../src/telegram/telegram.types';

const SECRET = 'ingest-secret-value';
const OWNER = 900000001;

type Env = Record<string, string | undefined>;

const configOf = (env: Env) => ({ get: (key: string): string | undefined => env[key] });

function makeController(env: Env = {}) {
  const config = configOf({
    INGEST_SECRET: SECRET,
    TEST_REFLECT_REPLY: 'false',
    ...env,
  });
  // The owner comes from a real TelegramService, the first id in ALLOWED_USERS; handling is mocked.
  const ownerSource = makeService({ ALLOWED_USERS: `${OWNER},900000002`, ...env });
  const telegram = { handleIngestedText: vi.fn().mockResolvedValue(undefined) };
  const controller = new IngestController(
    new IngestGuard(config as never, ownerSource),
    telegram as never,
    config as never,
  );
  return { controller, telegram };
}

/** A real TelegramService with the model and storage boundaries stubbed out. */
function makeService(env: Env = {}): TelegramService {
  const config = configOf({ TELEGRAM_BOT_TOKEN: 'fake:token', ...env });
  const off = { available: false } as never;
  return new TelegramService(config as never, off, off, off, off, off, off, new ClockService());
}

describe('POST /ingest/message auth', () => {
  let made: ReturnType<typeof makeController>;

  beforeEach(() => {
    made = makeController();
  });

  // acceptance: ingest-no-secret - 401 and nothing processed
  it('rejects a missing X-Ingest-Secret without processing anything', async () => {
    await expect(
      made.controller.message(undefined, undefined, { text: 'hello' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(made.telegram.handleIngestedText).not.toHaveBeenCalled();
  });

  // acceptance: ingest-wrong-secret
  it('rejects a wrong X-Ingest-Secret without processing anything', async () => {
    for (const wrong of ['', 'nope', `${SECRET}x`]) {
      await expect(
        made.controller.message(wrong, undefined, { text: 'hello' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(made.telegram.handleIngestedText).not.toHaveBeenCalled();
  });

  it('checks the secret before validating the body', async () => {
    await expect(made.controller.message('nope', undefined, { text: '' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('fails closed when INGEST_SECRET is unset or ALLOWED_USERS has no valid id', async () => {
    for (const env of [
      { INGEST_SECRET: undefined },
      { ALLOWED_USERS: '' },
      { ALLOWED_USERS: 'x' },
    ]) {
      const unconfigured = makeController(env);
      await expect(
        unconfigured.controller.message(SECRET, undefined, { text: 'hello' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(unconfigured.telegram.handleIngestedText).not.toHaveBeenCalled();
    }
  });
});

describe('POST /ingest/message validation', () => {
  let made: ReturnType<typeof makeController>;

  beforeEach(() => {
    made = makeController();
  });

  async function expectInvalid(body: unknown): Promise<void> {
    const error = await made.controller.message(SECRET, undefined, body).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      ok: false,
      error: 'invalid_text',
    });
  }

  // acceptance: ingest-empty-text
  it('answers 400 invalid_text for whitespace-only text', async () => {
    await expectInvalid({ text: '   ' });
  });

  it('answers 400 invalid_text when text is missing or not a string', async () => {
    for (const body of [undefined, null, {}, { text: 42 }, { text: null }, { text: ['a'] }]) {
      await expectInvalid(body);
    }
    expect(made.telegram.handleIngestedText).not.toHaveBeenCalled();
  });

  // acceptance: ingest-too-long
  it('answers 400 for text longer than INGEST_MAX_TEXT_CHARS (4000)', async () => {
    expect(INGEST_MAX_TEXT_CHARS).toBe(4000);
    await expectInvalid({ text: 'a'.repeat(4001) });
    expect(made.telegram.handleIngestedText).not.toHaveBeenCalled();
  });

  it('accepts text of exactly 4000 characters', async () => {
    const text = 'a'.repeat(4000);
    expect(await made.controller.message(SECRET, undefined, { text })).toEqual({ ok: true });
    expect(made.telegram.handleIngestedText).toHaveBeenCalledWith(OWNER, text, undefined, undefined);
  });
});

describe('POST /ingest/message handling', () => {
  it('passes the trimmed text and the first ALLOWED_USERS id, with no reflection in production', async () => {
    const made = makeController();

    const body = await made.controller.message(` ${SECRET}\n`, '2026-09-16T09:45:00+03:00', {
      text: '  Нотатка: код від гаража 4471 ',
    });

    expect(body).toEqual({ ok: true });
    expect(made.telegram.handleIngestedText).toHaveBeenCalledWith(
      OWNER,
      'Нотатка: код від гаража 4471',
      undefined,
      undefined,
    );
  });

  it('reflects replies and honours X-Test-Now on the test function', async () => {
    const made = makeController({ TEST_REFLECT_REPLY: 'true' });
    made.telegram.handleIngestedText.mockImplementation(
      async (_userId: number, _text: string, sink?: string[]) => {
        sink?.push('Saved as a note.');
      },
    );

    const body = await made.controller.message(SECRET, '2026-09-16T09:45:00+03:00', {
      text: 'hello',
    });

    expect(body).toEqual({ ok: true, replies: ['Saved as a note.'] });
    expect(made.telegram.handleIngestedText.mock.calls[0][3]).toBe('2026-09-16T09:45:00+03:00');
  });

  it('still answers 200 when handling throws after validation', async () => {
    const made = makeController();
    made.telegram.handleIngestedText.mockRejectedValueOnce(new Error('firestore is down'));

    expect(await made.controller.message(SECRET, undefined, { text: 'hello' })).toEqual({
      ok: true,
    });
  });
});

describe('TelegramService.handleIngestedText', () => {
  it('builds a private-chat update from the owner and feeds it to handleUpdate', async () => {
    const service = makeService();
    const spy = vi.spyOn(service, 'handleUpdate');

    await service.handleIngestedText(OWNER, 'hello', undefined, '2026-09-16T09:45:00+03:00');

    expect(spy).toHaveBeenCalledTimes(1);
    const [update, sink, nowOverride] = spy.mock.calls[0] as [TelegramUpdate, unknown, unknown];
    expect(update.message).toMatchObject({
      chat: { id: OWNER },
      from: { id: OWNER, is_bot: false },
      text: 'hello',
    });
    expect(typeof update.update_id).toBe('number');
    expect(typeof update.message?.message_id).toBe('number');
    expect(sink).toBeUndefined();
    expect(nowOverride).toBe('2026-09-16T09:45:00+03:00');
  });

  // acceptance: ingest-command-passthrough - commands route exactly as in the chat
  it('routes /version as a command, the same as a chat message', async () => {
    const replies: string[] = [];
    await makeService().handleIngestedText(OWNER, '/version', replies);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/^notes-bot \d+\.\d+\.\d+$/);
  });

  it('still goes through the ALLOWED_USERS gate', async () => {
    const replies: string[] = [];
    await makeService({ ALLOWED_USERS: '111111111' }).handleIngestedText(
      OWNER,
      '/version',
      replies,
    );

    expect(replies).toEqual(['Sorry, you are not allowed to use this bot.']);
  });
});
