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
const U1 = 900000001;
const U2 = 900000002;

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

const configured = () => makeGuard({ INGEST_SECRET: SECRET, ALLOWED_USERS: `${U1},${U2}` });

describe('TelegramService.isAllowedUserId / hasAllowlist', () => {
  const service = (allowed: string | undefined) => makeService({ ALLOWED_USERS: allowed });

  it('allows exactly the ids in ALLOWED_USERS, in any order', () => {
    for (const allowed of [`${U1},${U2}`, `${U2},${U1}`, ` ${U2} , ${U1}\n`]) {
      const s = service(allowed);
      expect(s.hasAllowlist()).toBe(true);
      expect(s.isAllowedUserId(U1)).toBe(true);
      expect(s.isAllowedUserId(U2)).toBe(true);
      expect(s.isAllowedUserId(900000007)).toBe(false);
    }
  });

  it('ignores invalid entries but keeps the valid ones', () => {
    const s = service('abc,1.5,,  ,900000003');
    expect(s.hasAllowlist()).toBe(true);
    expect(s.isAllowedUserId(900000003)).toBe(true);
    expect(s.isAllowedUserId(1)).toBe(false);
  });

  it('has no allowlist, and allows no id, when the list is unset, empty or has no valid id', () => {
    for (const allowed of [undefined, '', '   ', '\n', ',', ' , ,', 'abc', 'abc,1.5,x9']) {
      const s = service(allowed);
      expect(s.hasAllowlist()).toBe(false);
      expect(s.isAllowedUserId(U1)).toBe(false);
    }
  });

  it('no longer exposes ownerUserId', () => {
    expect((service(`${U1}`) as unknown as Record<string, unknown>).ownerUserId).toBeUndefined();
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

  it('accepts the right secret and returns no user', () => {
    expect(configured().assertIngestSecret(SECRET)).toBeUndefined();
  });

  it('trims whitespace and a trailing newline from the configured secret and allowlist', () => {
    const guard = makeGuard({ INGEST_SECRET: `${SECRET}\n`, ALLOWED_USERS: ` ${U1} ,7\n` });
    expect(() => guard.assertIngestSecret(SECRET)).not.toThrow();
  });

  // Fail closed, unlike the Telegram webhook where an unset secret skips the check.
  it('fails closed when INGEST_SECRET is not set', () => {
    for (const secret of [undefined, '', '  \n']) {
      const guard = makeGuard({ INGEST_SECRET: secret, ALLOWED_USERS: String(U1) });
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
