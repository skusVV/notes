import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { IngestGuard } from '../src/ingest/ingest.guard';

const SECRET = 'ingest-secret-value';
const OWNER = 900000001;

function makeGuard(env: Record<string, string | undefined>): IngestGuard {
  const config = { get: (key: string): string | undefined => env[key] };
  return new IngestGuard(config as never);
}

const configured = () => makeGuard({ INGEST_SECRET: SECRET, INGEST_USER_ID: String(OWNER) });

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

  it('accepts the right secret and returns the configured owner id', () => {
    expect(configured().assertIngestSecret(SECRET)).toBe(OWNER);
  });

  it('trims whitespace and a trailing newline from the configured secret and user id', () => {
    const guard = makeGuard({ INGEST_SECRET: `${SECRET}\n`, INGEST_USER_ID: ` ${OWNER}\n` });
    expect(guard.assertIngestSecret(SECRET)).toBe(OWNER);
  });

  // Decision 4: fail closed, unlike the Telegram webhook where an unset secret skips the check.
  it('fails closed when INGEST_SECRET is not set', () => {
    for (const secret of [undefined, '', '  \n']) {
      const guard = makeGuard({ INGEST_SECRET: secret, INGEST_USER_ID: String(OWNER) });
      expect(() => guard.assertIngestSecret(SECRET)).toThrow(UnauthorizedException);
      expect(() => guard.assertIngestSecret(undefined)).toThrow(UnauthorizedException);
      expect(() => guard.assertIngestSecret('')).toThrow(UnauthorizedException);
    }
  });

  it('fails closed when INGEST_USER_ID is not set or not a valid id', () => {
    for (const userId of [undefined, '', 'abc', '0', '-5', '1.5', '111,222']) {
      const guard = makeGuard({ INGEST_SECRET: SECRET, INGEST_USER_ID: userId });
      expect(() => guard.assertIngestSecret(SECRET)).toThrow(UnauthorizedException);
    }
  });
});
