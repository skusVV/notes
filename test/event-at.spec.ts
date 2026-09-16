import { describe, expect, it } from 'vitest';
import { EXPIRE_HOURS, computeExpireAt, normalizeEventAt } from '../src/reminders/event-at';

// A fixed "now": 2026-09-16T09:00:00+03:00 (the acceptance clock).
const NOW = new Date('2026-09-16T06:00:00.000Z');

describe('normalizeEventAt', () => {
  // acceptance: reminder-stored / relative-next-week / absolute-day-of-month (normalisation)
  it('normalises a valid future ISO with offset to canonical seconds precision', () => {
    expect(normalizeEventAt('2026-09-17T12:00:00+03:00', NOW)).toBe('2026-09-17T12:00:00+03:00');
  });

  it('drops milliseconds and adds seconds across input precisions, preserving the offset', () => {
    expect(normalizeEventAt('2026-09-17T12:00+03:00', NOW)).toBe('2026-09-17T12:00:00+03:00');
    expect(normalizeEventAt('2026-09-17T12:00:00.000+03:00', NOW)).toBe('2026-09-17T12:00:00+03:00');
    expect(normalizeEventAt('2026-09-17T12:00:00.742+03:00', NOW)).toBe('2026-09-17T12:00:00+03:00');
  });

  it('preserves a Z (UTC) offset', () => {
    expect(normalizeEventAt('2026-09-17T09:00:00Z', NOW)).toBe('2026-09-17T09:00:00Z');
  });

  // acceptance: missing-time-not-stored (rejection so the caller does not store a guessed time)
  it('rejects a missing, empty, or non-string value', () => {
    expect(normalizeEventAt(undefined, NOW)).toBeUndefined();
    expect(normalizeEventAt('', NOW)).toBeUndefined();
    expect(normalizeEventAt('   ', NOW)).toBeUndefined();
  });

  it('rejects an offset-less value: without an offset it does not pin an instant', () => {
    expect(normalizeEventAt('2026-09-17T12:00:00', NOW)).toBeUndefined();
    expect(normalizeEventAt('2026-09-17', NOW)).toBeUndefined();
  });

  it('rejects garbage', () => {
    expect(normalizeEventAt('not a date', NOW)).toBeUndefined();
    expect(normalizeEventAt('2026-13-40T99:00:00+03:00', NOW)).toBeUndefined();
  });

  it('rejects a time at or before now', () => {
    expect(normalizeEventAt('2026-09-16T09:00:00+03:00', NOW)).toBeUndefined(); // exactly now
    expect(normalizeEventAt('2026-09-15T12:00:00+03:00', NOW)).toBeUndefined(); // past
  });
});

describe('computeExpireAt', () => {
  // acceptance: expireAt-present (expireAt = eventAt + 24h)
  it('is exactly 24 hours after the event instant', () => {
    const eventAt = '2026-09-17T12:00:00+03:00';
    const expire = computeExpireAt(eventAt);
    const eventMs = new Date('2026-09-17T09:00:00.000Z').getTime();
    expect(expire.getTime()).toBe(eventMs + EXPIRE_HOURS * 60 * 60 * 1000);
    expect(EXPIRE_HOURS).toBe(24);
  });

  it('crosses a DST-free day boundary as a fixed 24h offset', () => {
    const expire = computeExpireAt('2026-09-17T23:30:00+03:00');
    expect(expire.toISOString()).toBe('2026-09-18T20:30:00.000Z');
  });
});
