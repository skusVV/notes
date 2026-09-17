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

describe('ClockService.plusHours', () => {
  const clock = new ClockService();

  // acceptance: callback-snooze-1h - the +1h button is measured from the tap, not from remindAt
  it('shifts an instant forward by whole hours', () => {
    const tap = clock.now('2026-09-16T10:05:00+03:00');

    expect(clock.formatLocal(clock.plusHours(tap, 1), 'Europe/Kyiv')).toBe(
      '2026-09-16T11:05:00+03:00',
    );
  });

  it('adds a real hour across a DST end, so the wall clock moves back by one', () => {
    // Kyiv leaves summer time at 04:00 local on 2026-10-25: 03:30+03:00 plus an hour is 03:30+02:00.
    const tap = clock.now('2026-10-25T03:30:00+03:00');

    expect(clock.formatLocal(clock.plusHours(tap, 1), 'Europe/Kyiv')).toBe(
      '2026-10-25T03:30:00+02:00',
    );
  });
});

describe('ClockService.nextDayAt', () => {
  const clock = new ClockService();

  // acceptance: callback-tomorrow - next calendar day at 09:00 local
  it('lands on 09:00 the following local day', () => {
    const tap = clock.now('2026-09-16T22:00:00+03:00');

    expect(clock.formatLocal(clock.nextDayAt(tap, 'Europe/Kyiv', 9), 'Europe/Kyiv')).toBe(
      '2026-09-17T09:00:00+03:00',
    );
  });

  it('still lands on 09:00 wall-clock when the zone changes offset overnight', () => {
    // Tapped the evening before Kyiv leaves summer time: the target is 09:00 at the NEW offset,
    // which is what "09:00 local" has to mean. A fixed +24h would land an hour early.
    const tap = clock.now('2026-10-24T22:00:00+03:00');

    expect(clock.formatLocal(clock.nextDayAt(tap, 'Europe/Kyiv', 9), 'Europe/Kyiv')).toBe(
      '2026-10-25T09:00:00+02:00',
    );
  });

  it('decides "the next day" in the given zone, not in UTC', () => {
    // 23:30 in Kyiv is still the 16th in UTC, so a UTC-based "tomorrow" would pick the wrong date.
    const tap = clock.now('2026-09-16T23:30:00+03:00');

    expect(clock.formatLocal(clock.nextDayAt(tap, 'Europe/Kyiv', 9), 'Europe/Kyiv')).toBe(
      '2026-09-17T09:00:00+03:00',
    );
  });

  it('degrades an unknown zone to UTC rather than throwing', () => {
    const tap = clock.now('2026-09-16T22:00:00Z');

    expect(clock.formatLocal(clock.nextDayAt(tap, 'Not/AZone', 9), 'UTC')).toBe(
      '2026-09-17T09:00:00Z',
    );
  });
});
