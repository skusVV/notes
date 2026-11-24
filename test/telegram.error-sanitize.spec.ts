import { inspect } from 'node:util';
import { ConsoleLogger } from '@nestjs/common';
import { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
// axios's own settle(): the exact code its http adapter runs to turn a 4xx/5xx into an AxiosError.
// @ts-expect-error - internal module, shipped without type declarations.
import settle from 'axios/unsafe/core/settle.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClockService } from '../src/clock/clock.service';
import { DueNotification } from '../src/reminders/reminders.service';
import { TelegramService } from '../src/telegram/telegram.service';

// BUG-0005: a failed Telegram call must not carry the bot token (it sits in axios's baseURL) or
// the outbound text (axios's config.data) into the logs. No axios mock here: the service builds
// real axios instances and only the transport adapter is swapped, so every error below is the
// AxiosError axios itself produces, with its real config, request and response attached.

const TOKEN = 'SECRET123';
const BODY_TEXT = 'private';

type Adapter = (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>;

function makeService(): TelegramService {
  const config = {
    get: (key: string): string | undefined => (key === 'TELEGRAM_BOT_TOKEN' ? TOKEN : undefined),
  };
  return new TelegramService(
    config as never,
    { available: false } as never,
    { available: false } as never,
    { available: false } as never,
    { available: false } as never,
    { available: false } as never,
    { available: false } as never,
    new ClockService(),
    { available: false } as never,
  );
}

function instances(service: TelegramService): { api: AxiosInstance; files: AxiosInstance } {
  const internals = service as unknown as { api: AxiosInstance; files: AxiosInstance };
  return { api: internals.api, files: internals.files };
}

/** A stand-in for Node's ClientRequest, carrying what the real one would: the tokenised path. */
function fakeRequest(config: InternalAxiosRequestConfig): Record<string, unknown> {
  const path = `${new URL(config.baseURL ?? '').pathname}${config.url ?? ''}`;
  return {
    method: config.method?.toUpperCase(),
    path,
    host: 'api.telegram.org',
    _header: `${config.method?.toUpperCase()} ${path} HTTP/1.1\r\nHost: api.telegram.org\r\n\r\n`,
  };
}

/** An adapter that answers with an HTTP error status, settled by axios's own code. */
function failingWith(status: number, data: unknown): Adapter {
  return (config) =>
    new Promise((resolve, reject) => {
      settle(resolve, reject, {
        data,
        status,
        statusText: 'Error',
        headers: { 'content-type': 'application/json' },
        config,
        request: fakeRequest(config),
      });
    });
}

/** An adapter that times out the way axios's http adapter does: no response at all. */
function timingOut(): Adapter {
  return (config) =>
    Promise.reject(
      new AxiosError(
        `timeout of ${config.timeout}ms exceeded`,
        AxiosError.ECONNABORTED,
        config,
        fakeRequest(config),
      ),
    );
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner === 'object' && inner !== null) {
      if (seen.has(inner)) {
        return '[Circular]';
      }
      seen.add(inner);
    }
    return inner;
  });
}

/**
 * Everything a log line could print for this error: message, stack, the JSON of its own enumerable
 * properties (and of its toJSON, which AxiosError defines), util.inspect, and what Nest's
 * ConsoleLogger actually writes for `logger.error(msg, error)`.
 */
function serialized(error: unknown): string {
  const err = error as Error & { toJSON?: () => unknown };
  const own = Object.fromEntries(Object.keys(err).map((key) => [key, (err as never)[key]]));

  const written: string[] = [];
  const capture = (chunk: unknown): boolean => {
    written.push(String(chunk));
    return true;
  };
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture as never);
  try {
    new ConsoleLogger('Test').error('Telegram call failed', err);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }

  return [
    err.message,
    err.stack ?? '',
    safeJson(own),
    typeof err.toJSON === 'function' ? safeJson(err.toJSON()) : '',
    inspect(err, { depth: 10 }),
    written.join(''),
  ].join('\n');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

function notification(): DueNotification {
  return {
    id: 'n1',
    ref: { id: 'n1' } as never,
    reminderId: 'r1',
    userId: 1,
    chatId: 42,
    title: BODY_TEXT,
    eventAt: '2026-12-01T16:00:00+02:00',
    atLocal: '2026-12-01T16:00:00+02:00',
  } as DueNotification;
}

describe('BUG-0005: Telegram errors carry no token and no body text', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // acceptance: repro-fixed
  it('a failed sendMessage rejects with an error that leaks neither the token nor the text', async () => {
    const service = makeService();
    const { api } = instances(service);
    expect(api.defaults.baseURL).toBe(`https://api.telegram.org/bot${TOKEN}`);
    api.defaults.adapter = failingWith(400, {
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    });

    const error = await rejection(service.sendDigest(42, BODY_TEXT));
    const out = serialized(error);

    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(BODY_TEXT);
    const message = (error as Error).message;
    expect(message).toContain('sendMessage');
    expect(message).toContain('400');
    expect(message).toContain('POST');
    expect(message).toContain('Bad Request: chat not found');
  });

  // acceptance: repro-fixed (the sweeper's path: sendReminder through the same instance)
  it('a failed sendReminder (5xx) is sanitized the same way', async () => {
    const service = makeService();
    instances(service).api.defaults.adapter = failingWith(502, '<html>Bad Gateway</html>');

    const error = await rejection(service.sendReminder(notification(), new Date('2026-12-01T15:45:00+02:00')));
    const out = serialized(error);

    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(BODY_TEXT);
    expect((error as Error).message).toContain('sendMessage');
    expect((error as Error).message).toContain('502');
  });

  it('a timeout keeps the axios error code and leaks nothing', async () => {
    const service = makeService();
    instances(service).api.defaults.adapter = timingOut();

    const error = await rejection(service.sendDigest(42, BODY_TEXT));
    const out = serialized(error);

    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(BODY_TEXT);
    expect((error as Error).message).toContain('sendMessage');
    expect((error as Error).message).toContain('ECONNABORTED');
    expect((error as { code?: unknown }).code).toBe('ECONNABORTED');
    expect((error as { response?: unknown }).response).toBeUndefined();
  });

  it("caps Telegram's description at 200 characters", async () => {
    const service = makeService();
    instances(service).api.defaults.adapter = failingWith(400, {
      ok: false,
      error_code: 400,
      description: `Bad Request: ${'x'.repeat(500)}`,
    });

    const error = await rejection(service.sendDigest(42, 'hello'));
    const message = (error as Error).message;
    expect(message).toContain('Bad Request: x');
    expect(message).not.toContain('x'.repeat(201));
  });

  // acceptance: file-api-too
  it('the file-download instance is sanitized the same way', async () => {
    const service = makeService();
    const { files } = instances(service);
    expect(files.defaults.baseURL).toBe(`https://api.telegram.org/file/bot${TOKEN}`);
    files.defaults.adapter = failingWith(404, { ok: false, error_code: 404, description: 'Not Found' });

    const error = await rejection(files.get(`/voice/${BODY_TEXT}.oga`));
    const out = serialized(error);

    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(BODY_TEXT);
    expect((error as Error).message).toContain('file download');
    expect((error as Error).message).toContain('404');
    expect((error as { response?: { status?: unknown } }).response?.status).toBe(404);
  });

  // acceptance: status-kept
  it('keeps only a numeric status under error.response', async () => {
    const service = makeService();
    instances(service).api.defaults.adapter = failingWith(403, {
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });

    const error = await rejection(service.sendDigest(42, BODY_TEXT));

    expect((error as { response?: unknown }).response).toEqual({ status: 403 });
    expect(Object.keys((error as { response: object }).response)).toEqual(['status']);
    expect((error as { config?: unknown }).config).toBeUndefined();
    expect((error as { request?: unknown }).request).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect((error as { isAxiosError?: unknown }).isAxiosError).toBeUndefined();
  });
});
