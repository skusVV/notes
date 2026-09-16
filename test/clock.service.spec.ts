import { describe, expect, it } from 'vitest';
import { ClockService } from '../src/clock/clock.service';

describe('ClockService.now', () => {
  const clock = new ClockService();

  // acceptance: the X-Test-Now override pins "now"
  it('parses a valid ISO override with offset', () => {
    expect(clock.now('2026-09-16T09:00:00+03:00').toISOString()).toBe('2026-09-16T06:00:00.000Z');
  });

  it('falls through to the real clock for an absent, offset-less, or garbage override', () => {
    const before = Date.now();
    for (const bad of [undefined, '', '   ', '2026-09-16T09:00:00', 'not a date']) {
      const value = clock.now(bad).getTime();
      expect(value).toBeGreaterThanOrEqual(before);
      expect(value).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });
});

describe('ClockService.formatLocal', () => {
  const clock = new ClockService();
  const instant = new Date('2026-09-16T06:00:00.000Z');

  // acceptance: ClockService override formatting -> local ISO with offset, seconds precision
  it('renders an instant in a given IANA zone as ISO with offset', () => {
    expect(clock.formatLocal(instant, 'Europe/Kyiv')).toBe('2026-09-16T09:00:00+03:00');
    expect(clock.formatLocal(instant, 'UTC')).toBe('2026-09-16T06:00:00Z');
  });

  it('round-trips a pinned override back to the same local string', () => {
    const pinned = clock.now('2026-09-16T09:00:00+03:00');
    expect(clock.formatLocal(pinned, 'Europe/Kyiv')).toBe('2026-09-16T09:00:00+03:00');
  });

  it('degrades an unknown zone to UTC rather than throwing', () => {
    expect(clock.formatLocal(instant, 'Not/AZone')).toBe('2026-09-16T06:00:00Z');
  });
});
