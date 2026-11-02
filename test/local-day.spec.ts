import { describe, expect, it } from 'vitest';
import { localDay } from '../src/digest/local-day';

const KYIV = 'Europe/Kyiv';
const HOUR = 3_600_000;

describe('localDay', () => {
  it('returns the local calendar day an ordinary morning falls in', () => {
    const day = localDay(new Date('2026-09-16T07:00:00+03:00'), KYIV);

    expect(day.dateKey).toBe('2026-09-16');
    expect(day.dayStart.toISOString()).toBe('2026-09-15T21:00:00.000Z');
    expect(day.dayEnd.toISOString()).toBe('2026-09-16T21:00:00.000Z');
    expect(day.dayEnd.getTime() - day.dayStart.getTime()).toBe(24 * HOUR);
  });

  it('decides the day in the zone, not in UTC', () => {
    // 22:30 UTC on the 15th is already 01:30 on the 16th in Kyiv.
    const day = localDay(new Date('2026-09-15T22:30:00Z'), KYIV);
    expect(day.dateKey).toBe('2026-09-16');
  });

  it('spring DST change: the day is 23 hours long', () => {
    // 2026-03-29: Kyiv moves 03:00 -> 04:00, from +02:00 to +03:00.
    const day = localDay(new Date('2026-03-29T12:00:00+03:00'), KYIV);

    expect(day.dateKey).toBe('2026-03-29');
    expect(day.dayStart.toISOString()).toBe('2026-03-28T22:00:00.000Z');
    expect(day.dayEnd.toISOString()).toBe('2026-03-29T21:00:00.000Z');
    expect(day.dayEnd.getTime() - day.dayStart.getTime()).toBe(23 * HOUR);
  });

  it('autumn DST change: the day is 25 hours long', () => {
    // 2026-10-25: Kyiv moves 04:00 -> 03:00, from +03:00 to +02:00.
    const day = localDay(new Date('2026-10-25T12:00:00+02:00'), KYIV);

    expect(day.dateKey).toBe('2026-10-25');
    expect(day.dayStart.toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(day.dayEnd.toISOString()).toBe('2026-10-25T22:00:00.000Z');
    expect(day.dayEnd.getTime() - day.dayStart.getTime()).toBe(25 * HOUR);
  });

  it('an instant late on the DST day still belongs to it', () => {
    const day = localDay(new Date('2026-10-25T23:59:00+02:00'), KYIV);
    expect(day.dateKey).toBe('2026-10-25');
  });

  it('now exactly at local midnight starts that day', () => {
    const now = new Date('2026-09-16T00:00:00+03:00');
    const day = localDay(now, KYIV);

    expect(day.dateKey).toBe('2026-09-16');
    expect(day.dayStart.getTime()).toBe(now.getTime());
  });

  it('one millisecond before midnight is still the previous day', () => {
    const day = localDay(new Date('2026-09-15T23:59:59.999+03:00'), KYIV);
    expect(day.dateKey).toBe('2026-09-15');
  });

  it('degrades an unknown zone to UTC instead of throwing', () => {
    const day = localDay(new Date('2026-09-16T01:00:00+03:00'), 'Not/AZone');

    expect(day.dateKey).toBe('2026-09-15');
    expect(day.dayStart.toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });
});
