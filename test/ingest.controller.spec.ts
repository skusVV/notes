import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep every outbound Telegram call off the network, as in telegram.service.spec.ts. The instance
// is hoisted so tests can assert that nothing was sent.
const http = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));
vi.mock('axios', () => ({
  default: { create: vi.fn(() => http) },
  create: vi.fn(() => http),
}));

import { ClockService } from '../src/clock/clock.service';
import {
  INGEST_MAX_TEXT_CHARS,
  IngestController,
  parseIngestUserId,
} from '../src/ingest/ingest.controller';
import { IngestGuard } from '../src/ingest/ingest.guard';
import { TelegramService } from '../src/telegram/telegram.service';
import { TelegramUpdate } from '../src/telegram/telegram.types';

const SECRET = 'ingest-secret-value';
const U1 = 900000001;
const U2 = 900000002;
const NOT_ALLOWED = 900000007;

type Env = Record<string, string | undefined>;

const configOf = (env: Env) => ({ get: (key: string): string | undefined => env[key] });

/** A real TelegramService with the model and storage boundaries stubbed out. */
function makeService(env: Env = {}): TelegramService {
  const config = configOf({ TELEGRAM_BOT_TOKEN: 'fake:token', ...env });
  const off = { available: false } as never;
  return new TelegramService(config as never, off, off, off, off, off, off, new ClockService());
}

/**
 * A controller over a real TelegramService, so the allowlist is the real one. `handleIngestedText`
 * is a spy that resolves without handling, unless `realHandling` is set.
 */
function makeController(env: Env = {}, realHandling = false) {
  const merged: Env = {
    INGEST_SECRET: SECRET,
    ALLOWED_USERS: `${U1},${U2}`,
    TEST_REFLECT_REPLY: 'false',
    ...env,
  };
  const config = configOf(merged);
  const service = makeService(merged);
  const ingested = vi.spyOn(service, 'handleIngestedText');
  if (!realHandling) {
    ingested.mockResolvedValue(undefined);
  }
  const updates = vi.spyOn(service, 'handleUpdate');
  const controller = new IngestController(
    new IngestGuard(config as never, service),
    service,
    config as never,
  );
  return { controller, service, ingested, updates };
}

/** The rejection of `promise`, or undefined when it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

beforeEach(() => {
  http.post.mockReset().mockResolvedValue({ data: {} });
  http.get.mockReset().mockResolvedValue({ data: Buffer.alloc(0) });
});

describe('parseIngestUserId', () => {
  it('accepts a positive integer as a number or a digit string', () => {
    expect(parseIngestUserId(U1)).toBe(U1);
    expect(parseIngestUserId(String(U2))).toBe(U2);
    expect(parseIngestUserId(` ${U2}\n`)).toBe(U2);
    expect(parseIngestUserId(1)).toBe(1);
    expect(parseIngestUserId('7')).toBe(7);
  });

  it('rejects missing, non-numeric, zero, negative, fractional and unsafe values', () => {
    for (const raw of [
      undefined,
      null,
      '',
      '   ',
      'abc',
      '12abc',
      0,
      '0',
      '000',
      -5,
      '-5',
      1.5,
      '1.5',
      '1e5',
      '0x10',
      '+5',
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '9007199254740993',
      true,
      [U1],
      { id: U1 },
    ]) {
      expect(parseIngestUserId(raw)).toBeUndefined();
    }
  });
});

describe('POST /ingest/message auth (401)', () => {
  let made: ReturnType<typeof makeController>;

  beforeEach(() => {
    made = makeController();
  });

  // acceptance: ingest-no-secret - 401 and nothing processed
  it('rejects a missing X-Ingest-Secret without processing anything', async () => {
    const error = await rejectionOf(
      made.controller.message(undefined, undefined, { userId: U1, text: 'Нотатка: маркер 5501' }),
    );
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(made.ingested).not.toHaveBeenCalled();
  });

  // acceptance: ingest-wrong-secret
  it('rejects a wrong X-Ingest-Secret without processing anything', async () => {
    for (const wrong of ['', 'nope', `${SECRET}x`]) {
      const error = await rejectionOf(
        made.controller.message(wrong, undefined, { userId: U1, text: 'hello' }),
      );
      expect(error).toBeInstanceOf(UnauthorizedException);
    }
    expect(made.ingested).not.toHaveBeenCalled();
  });

  it('checks the secret before validating the body', async () => {
    for (const body of [{ text: '' }, { userId: 'abc', text: 'hello' }, { userId: NOT_ALLOWED }]) {
      const error = await rejectionOf(made.controller.message('nope', undefined, body));
      expect(error).toBeInstanceOf(UnauthorizedException);
    }
  });

  it('fails closed when INGEST_SECRET is unset or ALLOWED_USERS is unset, empty or invalid', async () => {
    for (const env of [
      { INGEST_SECRET: undefined },
      { INGEST_SECRET: '' },
      { ALLOWED_USERS: undefined },
      { ALLOWED_USERS: '' },
      { ALLOWED_USERS: '  \n' },
      { ALLOWED_USERS: 'x' },
    ]) {
      const unconfigured = makeController(env);
      const error = await rejectionOf(
        unconfigured.controller.message(SECRET, undefined, { userId: U1, text: 'hello' }),
      );
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(unconfigured.ingested).not.toHaveBeenCalled();
    }
  });
});

describe('POST /ingest/message validation (400)', () => {
  let made: ReturnType<typeof makeController>;

  beforeEach(() => {
    made = makeController();
  });

  async function expect400(body: unknown, code: 'invalid_text' | 'invalid_user'): Promise<void> {
    const error = await rejectionOf(made.controller.message(SECRET, undefined, body));
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({ ok: false, error: code });
  }

  // acceptance: ingest-empty-text
  it('answers 400 invalid_text for whitespace-only text', async () => {
    await expect400({ userId: U1, text: '   ' }, 'invalid_text');
    expect(made.ingested).not.toHaveBeenCalled();
  });

  it('answers 400 invalid_text when text is missing or not a string', async () => {
    for (const body of [
      undefined,
      null,
      {},
      { userId: U1 },
      { userId: U1, text: 42 },
      { userId: U1, text: null },
      { userId: U1, text: ['a'] },
    ]) {
      await expect400(body, 'invalid_text');
    }
    expect(made.ingested).not.toHaveBeenCalled();
  });

  it('answers 400 invalid_text for text longer than INGEST_MAX_TEXT_CHARS (4000)', async () => {
    expect(INGEST_MAX_TEXT_CHARS).toBe(4000);
    await expect400({ userId: U1, text: 'a'.repeat(4001) }, 'invalid_text');
    expect(made.ingested).not.toHaveBeenCalled();
  });

  it('accepts text of exactly 4000 characters', async () => {
    const text = 'a'.repeat(4000);
    expect(await made.controller.message(SECRET, undefined, { userId: U1, text })).toEqual({
      ok: true,
    });
    expect(made.ingested).toHaveBeenCalledWith(U1, text, undefined, undefined);
  });

  it('reports invalid_text, not invalid_user, when both are bad', async () => {
    await expect400({ text: '  ' }, 'invalid_text');
    await expect400({ userId: 'abc', text: 42 }, 'invalid_text');
  });

  // acceptance: ingest-missing-userid
  it('answers 400 invalid_user when userId is missing', async () => {
    await expect400({ text: 'Нотатка: маркер 5502' }, 'invalid_user');
    await expect400({ userId: null, text: 'Нотатка: маркер 5502' }, 'invalid_user');
    expect(made.ingested).not.toHaveBeenCalled();
    expect(made.updates).not.toHaveBeenCalled();
  });

  // acceptance: ingest-bad-userid
  it('answers 400 invalid_user for a non-numeric, zero, negative or fractional userId', async () => {
    for (const userId of ['abc', 0, -5, 1.5, '0', '-5', '1.5', '', true, [U1]]) {
      await expect400({ userId, text: 'Нотатка: маркер 5503' }, 'invalid_user');
    }
    expect(made.ingested).not.toHaveBeenCalled();
    expect(made.updates).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('checks userId format before the allowlist', async () => {
    // A malformed id is a 400 even though it is also not allowed.
    await expect400({ userId: '-900000001', text: 'hello' }, 'invalid_user');
  });
});

describe('POST /ingest/message allowlist (403)', () => {
  // acceptance: ingest-userid-not-allowed
  it('answers 403 user_not_allowed, never calls handleUpdate and sends nothing', async () => {
    const made = makeController({ TEST_REFLECT_REPLY: 'true' }, true);

    for (const userId of [NOT_ALLOWED, String(NOT_ALLOWED)]) {
      const error = await rejectionOf(
        made.controller.message(SECRET, undefined, { userId, text: 'Нотатка: маркер 5504' }),
      );
      expect(error).toBeInstanceOf(ForbiddenException);
      // The whole body: no 'replies', even on the reflecting test function.
      expect((error as ForbiddenException).getResponse()).toEqual({
        ok: false,
        error: 'user_not_allowed',
      });
    }

    expect(made.ingested).not.toHaveBeenCalled();
    expect(made.updates).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
  });

  it('does not depend on the order of ALLOWED_USERS', async () => {
    const made = makeController({ ALLOWED_USERS: `${U2},900000003,${U1}` });
    for (const userId of [U1, U2, 900000003]) {
      expect(await made.controller.message(SECRET, undefined, { userId, text: 'hi' })).toEqual({
        ok: true,
      });
    }
    expect(made.ingested.mock.calls.map((call) => call[0])).toEqual([U1, U2, 900000003]);
  });
});

describe('POST /ingest/message handling (200)', () => {
  it('passes the trimmed text and the body userId, with no reflection in production', async () => {
    const made = makeController();

    const body = await made.controller.message(` ${SECRET}\n`, '2026-09-16T09:45:00+03:00', {
      userId: U1,
      text: '  Нотатка: код від сейфа 7733 ',
    });

    expect(body).toEqual({ ok: true });
    expect(made.ingested).toHaveBeenCalledWith(
      U1,
      'Нотатка: код від сейфа 7733',
      undefined,
      undefined,
    );
  });

  // acceptance: ingest-userid-as-string
  it('accepts userId as a digit string and passes it on as a number', async () => {
    const made = makeController();

    await made.controller.message(SECRET, undefined, {
      userId: String(U2),
      text: 'Нотатка: код від шафи 9955',
    });

    expect(made.ingested).toHaveBeenCalledWith(U2, 'Нотатка: код від шафи 9955', undefined, undefined);
  });

  // acceptance: ingest-note-per-user
  it('files two requests under two users: different from.id and chat.id', async () => {
    const made = makeController({}, true);
    made.updates.mockResolvedValue(undefined);

    await made.controller.message(SECRET, undefined, {
      userId: U1,
      text: 'Нотатка: код від сейфа 7733',
    });
    await made.controller.message(SECRET, undefined, {
      userId: String(U2),
      text: 'Нотатка: код від гаража 8844',
    });

    expect(made.updates).toHaveBeenCalledTimes(2);
    const [first, second] = made.updates.mock.calls.map((call) => call[0] as TelegramUpdate);
    expect(first.message).toMatchObject({
      chat: { id: U1 },
      from: { id: U1, is_bot: false },
      text: 'Нотатка: код від сейфа 7733',
    });
    expect(second.message).toMatchObject({
      chat: { id: U2 },
      from: { id: U2, is_bot: false },
      text: 'Нотатка: код від гаража 8844',
    });
  });

  it('reflects replies and honours X-Test-Now on the test function', async () => {
    const made = makeController({ TEST_REFLECT_REPLY: 'true' });
    made.ingested.mockImplementation(async (_userId: number, _text: string, sink?: string[]) => {
      sink?.push('Saved as a note.');
    });

    const body = await made.controller.message(SECRET, '2026-09-16T09:45:00+03:00', {
      userId: U1,
      text: 'hello',
    });

    expect(body).toEqual({ ok: true, replies: ['Saved as a note.'] });
    expect(made.ingested.mock.calls[0][3]).toBe('2026-09-16T09:45:00+03:00');
  });

  // acceptance: ingest-command-passthrough
  it('routes /version for the body user, end to end', async () => {
    const made = makeController({ TEST_REFLECT_REPLY: 'true' }, true);

    const body = await made.controller.message(SECRET, undefined, {
      userId: U1,
      text: '/version',
    });

    expect(body.replies).toHaveLength(1);
    expect(body.replies?.[0]).toMatch(/^notes-bot \d+\.\d+\.\d+$/);
  });

  it('still answers 200 when handling throws after validation', async () => {
    const made = makeController();
    made.ingested.mockRejectedValueOnce(new Error('firestore is down'));

    expect(await made.controller.message(SECRET, undefined, { userId: U1, text: 'hello' })).toEqual(
      { ok: true },
    );
  });
});

describe('TelegramService.handleIngestedText', () => {
  it('builds a private-chat update from the given user and feeds it to handleUpdate', async () => {
    const service = makeService();
    const spy = vi.spyOn(service, 'handleUpdate');

    await service.handleIngestedText(U1, 'hello', undefined, '2026-09-16T09:45:00+03:00');

    expect(spy).toHaveBeenCalledTimes(1);
    const [update, sink, nowOverride] = spy.mock.calls[0] as [TelegramUpdate, unknown, unknown];
    expect(update.message).toMatchObject({
      chat: { id: U1 },
      from: { id: U1, is_bot: false },
      text: 'hello',
    });
    expect(typeof update.update_id).toBe('number');
    expect(typeof update.message?.message_id).toBe('number');
    expect(sink).toBeUndefined();
    expect(nowOverride).toBe('2026-09-16T09:45:00+03:00');
  });

  it('uses the given user id for both from.id and chat.id', async () => {
    const service = makeService();
    const spy = vi.spyOn(service, 'handleUpdate').mockResolvedValue(undefined);

    await service.handleIngestedText(U1, 'a');
    await service.handleIngestedText(U2, 'b');

    const [a, b] = spy.mock.calls.map((call) => (call[0] as TelegramUpdate).message);
    expect([a?.from?.id, a?.chat.id]).toEqual([U1, U1]);
    expect([b?.from?.id, b?.chat.id]).toEqual([U2, U2]);
  });

  it('routes /version as a command, the same as a chat message', async () => {
    const replies: string[] = [];
    await makeService().handleIngestedText(U1, '/version', replies);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/^notes-bot \d+\.\d+\.\d+$/);
  });

  it('still goes through the ALLOWED_USERS gate', async () => {
    const replies: string[] = [];
    await makeService({ ALLOWED_USERS: '111111111' }).handleIngestedText(U1, '/version', replies);

    expect(replies).toEqual(['Sorry, you are not allowed to use this bot.']);
  });
});
