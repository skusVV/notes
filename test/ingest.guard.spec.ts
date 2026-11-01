import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

// Keep every outbound Telegram call off the network, as in telegram.service.spec.ts.
vi.mock('axios', () => {
  const instance = {
    post: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: Buffer.alloc(0) }),
  };
  return { default: { create: vi.fn(() => instance) }, create: vi.fn(() => instance) };
});

import { ClockService } from '../src/clock/clock.service';
import { IngestGuard } from '../src/ingest/ingest.guard';
import { TelegramService } from '../src/telegram/telegram.service';

const SECRET = 'ingest-secret-value';
const OWNER = 900000001;

type Env = Record<string, string | undefined>;

const configOf = (env: Env) => ({ get: (key: string): string | undefined => env[key] });

/** A real TelegramService with the model and storage boundaries stubbed out. */
function makeService(env: Env): TelegramService {
  const config = configOf({ TELEGRAM_BOT_TOKEN: 'fake:token', ...env });
  const off = { available: false } as never;
  return new TelegramService(config as never, off, off, off, off, off, off, new ClockService());
}

function makeGuard(env: Env): IngestGuard {
  return new IngestGuard(configOf(env) as never, makeService(env));
}

const configured = () => makeGuard({ INGEST_SECRET: SECRET, ALLOWED_USERS: `${OWNER},900000002` });

describe('TelegramService.ownerUserId', () => {
  const owner = (allowed: string | undefined) =>
    makeService({ ALLOWED_USERS: allowed }).ownerUserId();

  it('returns the first id in ALLOWED_USERS', () => {
    expect(owner('900000001,900000002,900000003')).toBe(900000001);
    expect(owner('555')).toBe(555);
  });

  it('keeps the written order rather than sorting', () => {
    expect(owner('900000006,900000001,123')).toBe(900000006);
    expect(owner('123,900000001')).toBe(123);
  });

  it('ignores whitespace, empty entries and invalid entries before the first valid id', () => {
    expect(owner('  900000001 , 900000002\n')).toBe(900000001);
    expect(owner(' , ,900000002,900000001')).toBe(900000002);
    expect(owner('abc,1.5,,  ,900000003,900000001')).toBe(900000003);
  });

  it('is undefined when the list is unset, empty or has no valid id', () => {
    for (const allowed of [undefined, '', '   ', '\n', ',', ' , ,', 'abc', 'abc,1.5,x9']) {
      expect(owner(allowed)).toBeUndefined();
    }
  });
});

describe('IngestGuard.assertIngestSecret', () => {
  // acceptance: ingest-no-secret
  it('rejects a missing secret', () => {
    expect(() => configured().assertIngestSecret(undefined)).toThrow(UnauthorizedException);
  });

  // acceptance: ingest-wrong-secret
  it('rejects a wrong secret, including prefixes and extensions of the right one', () => {
    for (const wrong of ['', 'nope', `${SECRET}x`, SECRET.slice(0, -1), SECRET.toUpperCase()]) {
      expect(() => configured().assertIngestSecret(wrong)).toThrow(UnauthorizedException);
    }
  });

  // acceptance: ingest-owner-is-first-allowed-id
  it('accepts the right secret and returns the first id in ALLOWED_USERS as the owner', () => {
    expect(configured().assertIngestSecret(SECRET)).toBe(OWNER);

    const reordered = makeGuard({ INGEST_SECRET: SECRET, ALLOWED_USERS: `900000002,${OWNER}` });
    expect(reordered.assertIngestSecret(SECRET)).toBe(900000002);
  });

  it('trims whitespace and a trailing newline from the configured secret and allowlist', () => {
    const guard = makeGuard({ INGEST_SECRET: `${SECRET}\n`, ALLOWED_USERS: ` ${OWNER} ,7\n` });
    expect(guard.assertIngestSecret(SECRET)).toBe(OWNER);
  });

  it('ignores INGEST_USER_ID entirely', () => {
    const guard = makeGuard({
      INGEST_SECRET: SECRET,
      ALLOWED_USERS: String(OWNER),
      INGEST_USER_ID: '111111111',
    });
    expect(guard.assertIngestSecret(SECRET)).toBe(OWNER);
  });

  // Fail closed, unlike the Telegram webhook where an unset secret skips the check.
  it('fails closed when INGEST_SECRET is not set', () => {
    for (const secret of [undefined, '', '  \n']) {
      const guard = makeGuard({ INGEST_SECRET: secret, ALLOWED_USERS: String(OWNER) });
      expect(() => guard.assertIngestSecret(SECRET)).toThrow(UnauthorizedException);
      expect(() => guard.assertIngestSecret(undefined)).toThrow(UnauthorizedException);
      expect(() => guard.assertIngestSecret('')).toThrow(UnauthorizedException);
    }
  });

  it('fails closed when ALLOWED_USERS is unset, empty or has no valid id', () => {
    for (const allowed of [undefined, '', '  \n', ',', 'abc', 'abc, 1.5']) {
      const guard = makeGuard({ INGEST_SECRET: SECRET, ALLOWED_USERS: allowed });
      expect(() => guard.assertIngestSecret(SECRET)).toThrow(UnauthorizedException);
    }
  });
});
