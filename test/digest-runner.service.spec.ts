import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep every outbound Telegram call off the network. The instance is hoisted so tests can make a
// send fail and count how many were attempted.
const http = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));
vi.mock('axios', () => ({
  default: { create: vi.fn(() => http) },
  create: vi.fn(() => http),
}));

import { ClockService } from '../src/clock/clock.service';
import { DigestRunnerService } from '../src/digest/digest-runner.service';
import { DigestService } from '../src/digest/digest.service';
import { DigestSection } from '../src/digest/digest.types';
import { IngestController } from '../src/ingest/ingest.controller';
import { IngestGuard } from '../src/ingest/ingest.guard';
import { TelegramService } from '../src/telegram/telegram.service';
import { fakeDigestStore } from './fake-digest-store';

const U3 = 900000003;
const U5 = 900000005;
const NOT_ALLOWED = 900000007;
const SECRET = 'ingest-secret-value';
const MORNING = new Date('2026-09-16T07:00:00+03:00');
const NEXT_MORNING = new Date('2026-09-17T07:00:00+03:00');

type Env = Record<string, string | undefined>;
const configOf = (env: Env) => ({ get: (key: string): string | undefined => env[key] });

function makeTelegram(env: Env = {}): TelegramService {
  const config = configOf({ TELEGRAM_BOT_TOKEN: 'fake:token', ...env });
  const off = { available: false } as never;
  return new TelegramService(config as never, off, off, off, off, off, off, new ClockService(), off);
}

/** A section that shows `lines` (or nothing when empty), counting how often it was asked. */
function stubSection(lines: string[]) {
  const section: DigestSection & { calls: number } = {
    id: 'reminders',
    order: 100,
    calls: 0,
    async build() {
      section.calls += 1;
      return lines.length ? { title: 'Нагадування', lines } : null;
    },
  };
  return section;
}

function makeRunner(
  options: {
    seed?: Record<string, Record<string, unknown>>;
    lines?: string[];
    telegram?: TelegramService;
  } = {},
) {
  const store = fakeDigestStore(options.seed);
  const section = stubSection(options.lines ?? ['take pills - о 14:00']);
  const telegram = options.telegram ?? makeTelegram();
  const send = vi.spyOn(telegram, 'sendDigest');
  const runner = new DigestRunnerService(
    store.settings,
    new DigestService([section]),
    telegram,
    { defaultTimezone: 'Europe/Kyiv' } as never,
  );
  return { runner, store, section, send };
}

const enabled = (extra: Record<string, unknown> = {}) => ({
  [`users/${U3}`]: { digest: { enabled: true, chatId: U3, ...extra } },
});

beforeEach(() => {
  http.post.mockReset().mockResolvedValue({ data: {} });
  http.get.mockReset().mockResolvedValue({ data: Buffer.alloc(0) });
});

describe('DigestRunnerService.run', () => {
  it('disabled: no settings at all sends nothing and reads no section', async () => {
    const { runner, section, send } = makeRunner();

    expect(await runner.run(U5, MORNING)).toEqual({ sent: false, reason: 'disabled' });
    expect(section.calls).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('disabled: enabled == false sends nothing', async () => {
    const { runner, send } = makeRunner({
      seed: { [`users/${U3}`]: { digest: { enabled: false, chatId: U3 } } },
    });

    expect(await runner.run(U3, MORNING)).toEqual({ sent: false, reason: 'disabled' });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the digest once and claims the local day', async () => {
    const { runner, store, send } = makeRunner({ seed: enabled({ lastSentOn: null }) });
    const sink: string[] = [];

    expect(await runner.run(U3, MORNING, sink)).toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(U3);
    expect(sink).toHaveLength(1);
    expect(sink[0].startsWith('Доброго ранку')).toBe(true);
    expect(sink[0]).toContain('take pills');
    expect(sink[0]).toContain('14:00');
    expect((store.docs.get(`users/${U3}`)?.digest as { lastSentOn: string }).lastSentOn).toBe(
      '2026-09-16',
    );
  });

  it('already_sent: lastSentOn is today, so nothing is built or sent', async () => {
    const { runner, section, send } = makeRunner({ seed: enabled({ lastSentOn: '2026-09-16' }) });

    expect(await runner.run(U3, MORNING)).toEqual({ sent: false, reason: 'already_sent' });
    expect(section.calls).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('a second call the same day is already_sent; the next day sends again', async () => {
    const { runner, send } = makeRunner({ seed: enabled() });

    expect(await runner.run(U3, MORNING)).toEqual({ sent: true });
    expect(await runner.run(U3, MORNING)).toEqual({ sent: false, reason: 'already_sent' });
    expect(await runner.run(U3, NEXT_MORNING)).toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('empty: nothing to show sends nothing and does not claim the day', async () => {
    const { runner, store, send } = makeRunner({ seed: enabled(), lines: [] });

    expect(await runner.run(U3, MORNING)).toEqual({ sent: false, reason: 'empty' });
    expect(send).not.toHaveBeenCalled();
    expect((store.docs.get(`users/${U3}`)?.digest as Record<string, unknown>).lastSentOn).toBe(
      undefined,
    );
  });

  it('losing the claim race to an overlapping call is already_sent, with no send', async () => {
    const { runner, store, send } = makeRunner({ seed: enabled() });
    // The overlapping caller commits its claim between our first read and our transaction.
    store.hooks.beforeTransaction = () => {
      store.docs.set(`users/${U3}`, {
        digest: { enabled: true, chatId: U3, lastSentOn: '2026-09-16' },
      });
    };

    expect(await runner.run(U3, MORNING)).toEqual({ sent: false, reason: 'already_sent' });
    expect(send).not.toHaveBeenCalled();
  });

  it('send_failed: a failed send is reported, not retried, and the day stays claimed', async () => {
    const error = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403 },
    });
    http.post.mockRejectedValue(error);
    const { runner, store } = makeRunner({ seed: enabled() });

    // Production mode (no sink): the Telegram failure propagates to the runner.
    expect(await runner.run(U3, MORNING)).toEqual({ sent: false, reason: 'send_failed' });
    expect(http.post).toHaveBeenCalledTimes(1);
    expect((store.docs.get(`users/${U3}`)?.digest as { lastSentOn: string }).lastSentOn).toBe(
      '2026-09-16',
    );

    // A repeat call the same day sends nothing either.
    expect(await runner.run(U3, MORNING)).toEqual({ sent: false, reason: 'already_sent' });
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('sends to the chat stored by /digest on', async () => {
    const { runner, send } = makeRunner({
      seed: { [`users/${U3}`]: { digest: { enabled: true, chatId: 4242 } } },
    });

    await runner.run(U3, MORNING);
    expect(send.mock.calls[0][0]).toBe(4242);
  });
});

/** A controller over a real TelegramService and guard, with the runner stubbed. */
function makeController(env: Env = {}) {
  const merged: Env = {
    INGEST_SECRET: SECRET,
    ALLOWED_USERS: `${U3},${U5}`,
    TEST_REFLECT_REPLY: 'false',
    ...env,
  };
  const config = configOf(merged);
  const telegram = makeTelegram(merged);
  const run = vi.fn().mockResolvedValue({ sent: true });
  const runner = { run } as unknown as DigestRunnerService;
  const controller = new IngestController(
    new IngestGuard(config as never, telegram),
    telegram,
    config as never,
    runner,
    new ClockService(),
  );
  return { controller, run };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('POST /ingest/digest check order', () => {
  it('401 without a secret or with a wrong one, before the body is looked at', async () => {
    const { controller, run } = makeController();

    expect(await rejectionOf(controller.digest(undefined, undefined, { userId: U3 }))).toBeInstanceOf(
      UnauthorizedException,
    );
    expect(await rejectionOf(controller.digest('wrong', undefined, {}))).toBeInstanceOf(
      UnauthorizedException,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('401 when INGEST_SECRET is unset, even with a matching-looking header', async () => {
    const { controller, run } = makeController({ INGEST_SECRET: undefined });
    expect(await rejectionOf(controller.digest(SECRET, undefined, { userId: U3 }))).toBeInstanceOf(
      UnauthorizedException,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('400 invalid_user for a missing or malformed userId', async () => {
    const { controller, run } = makeController();

    for (const body of [{}, { userId: 0 }, { userId: 'abc' }, { userId: -3 }, null]) {
      const error = await rejectionOf(controller.digest(SECRET, undefined, body));
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual({
        ok: false,
        error: 'invalid_user',
      });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('403 user_not_allowed for an id outside ALLOWED_USERS, before anything runs', async () => {
    const { controller, run } = makeController();

    const error = await rejectionOf(controller.digest(SECRET, undefined, { userId: NOT_ALLOWED }));
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual({
      ok: false,
      error: 'user_not_allowed',
    });
    expect(run).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('a wrong secret wins over a bad userId (401 before 400)', async () => {
    const { controller } = makeController();
    expect(await rejectionOf(controller.digest('wrong', undefined, {}))).toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('accepts a digit-string userId and returns the runner result with 200 fields', async () => {
    const { controller, run } = makeController();
    run.mockResolvedValue({ sent: false, reason: 'disabled' });

    expect(await controller.digest(SECRET, undefined, { userId: String(U5) })).toEqual({
      ok: true,
      sent: false,
      reason: 'disabled',
    });
    expect(run.mock.calls[0][0]).toBe(U5);
  });

  it('a runner failure is logged and still answers ok with sent false', async () => {
    const { controller, run } = makeController();
    run.mockRejectedValue(new Error('firestore is down'));

    expect(await controller.digest(SECRET, undefined, { userId: U3 })).toEqual({
      ok: true,
      sent: false,
    });
  });

  it('reflect mode returns replies and honours X-Test-Now; production ignores both', async () => {
    const reflect = makeController({ TEST_REFLECT_REPLY: 'true' });
    reflect.run.mockImplementation(async (_id: number, _now: Date, sink?: string[]) => {
      sink?.push('Доброго ранку! Сьогодні 16 вересня.');
      return { sent: true };
    });

    expect(
      await reflect.controller.digest(SECRET, '2026-09-16T07:00:00+03:00', { userId: U3 }),
    ).toEqual({ ok: true, sent: true, replies: ['Доброго ранку! Сьогодні 16 вересня.'] });
    expect((reflect.run.mock.calls[0][1] as Date).toISOString()).toBe('2026-09-16T04:00:00.000Z');

    const prod = makeController();
    const result = await prod.controller.digest(SECRET, '2026-09-16T07:00:00+03:00', {
      userId: U3,
    });
    expect(result).toEqual({ ok: true, sent: true });
    expect((prod.run.mock.calls[0][1] as Date).toISOString()).not.toBe('2026-09-16T04:00:00.000Z');
  });
});
