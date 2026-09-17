import { describe, expect, it } from 'vitest';
import {
  EVENING_HOUR,
  MORNING_HOUR,
  resolveNotifyTimes,
  resolveRelativeNotify,
} from '../src/reminders/notify-times';

// The appointment from the spec: "a doctor appointment on the 22nd at 2PM".
const EVENT_AT = '2026-09-22T14:00:00+03:00';
const NOW = new Date('2026-09-16T09:00:00+03:00');

describe('resolveRelativeNotify', () => {
  // acceptance: two-notifications-captured - "the evening before" is 19:00 the day before
  it('resolves "evening before" to 19:00 local on the previous day', () => {
    expect(resolveRelativeNotify('evening_before', EVENT_AT)).toBe('2026-09-21T19:00:00+03:00');
    expect(EVENING_HOUR).toBe(19);
  });

  // acceptance: two-notifications-captured - "the morning of" is 09:00 on the event's own day
  it('resolves "morning of" to 09:00 local on the day of the event', () => {
    expect(resolveRelativeNotify('morning_of', EVENT_AT)).toBe('2026-09-22T09:00:00+03:00');
    expect(MORNING_HOUR).toBe(9);
  });

  it('resolves the other two day/part-of-day combinations the same way', () => {
    expect(resolveRelativeNotify('morning_before', EVENT_AT)).toBe('2026-09-21T09:00:00+03:00');
    expect(resolveRelativeNotify('evening_of', EVENT_AT)).toBe('2026-09-22T19:00:00+03:00');
  });

  // acceptance: single-default-notification - "then" means the event instant itself, unchanged
  it('resolves "at event" to the event instant itself', () => {
    expect(resolveRelativeNotify('at_event', EVENT_AT)).toBe(EVENT_AT);
  });

  it('keeps the zone the event carries rather than the server\'s', () => {
    expect(resolveRelativeNotify('morning_of', '2026-12-25T14:00:00+02:00')).toBe(
      '2026-12-25T09:00:00+02:00',
    );
  });

  it('returns nothing for an unusable eventAt instead of inventing a time', () => {
    expect(resolveRelativeNotify('morning_of', 'not a date')).toBeUndefined();
  });
});

describe('resolveNotifyTimes', () => {
  // acceptance: two-notifications-captured - one appointment, exactly two notify instants
  it('resolves "the evening before and the morning of" into two ascending instants', () => {
    expect(resolveNotifyTimes(EVENT_AT, ['evening_before', 'morning_of'], NOW)).toEqual([
      '2026-09-21T19:00:00+03:00',
      '2026-09-22T09:00:00+03:00',
    ]);
  });

  // acceptance: single-default-notification - no notify phrasing means one nudge at eventAt
  it('falls back to exactly one notification at eventAt when none was requested', () => {
    for (const requested of [undefined, [], ['   ']]) {
      expect(resolveNotifyTimes(EVENT_AT, requested, NOW)).toEqual([EVENT_AT]);
    }
  });

  it('accepts an explicit ISO instant with an offset', () => {
    expect(resolveNotifyTimes(EVENT_AT, ['2026-09-20T08:30:00+03:00'], NOW)).toEqual([
      '2026-09-20T08:30:00+03:00',
    ]);
  });

  it('drops an entry it cannot resolve rather than guessing, keeping the ones it can', () => {
    expect(
      resolveNotifyTimes(EVENT_AT, ['the evening before', '2026-09-20T08:00:00', 'morning_of'], NOW),
    ).toEqual(['2026-09-22T09:00:00+03:00']);
  });

  it('falls back to eventAt when nothing given resolves', () => {
    expect(resolveNotifyTimes(EVENT_AT, ['whenever', '2026-09-20T08:00:00'], NOW)).toEqual([
      EVENT_AT,
    ]);
  });

  it('drops a notify time already in the past, which would fire on the very next sweep', () => {
    // "the morning of" for an event later today, asked for at 09:45 - 09:00 has passed.
    const today = '2026-09-16T14:00:00+03:00';
    const late = new Date('2026-09-16T09:45:00+03:00');

    expect(resolveNotifyTimes(today, ['morning_of'], late)).toEqual([today]);
  });

  it('de-duplicates two phrasings that land on the same instant', () => {
    expect(resolveNotifyTimes(EVENT_AT, ['morning_of', '2026-09-22T09:00:00+03:00'], NOW)).toEqual([
      '2026-09-22T09:00:00+03:00',
    ]);
  });

  it('sorts by instant, not by the order the model listed them', () => {
    expect(resolveNotifyTimes(EVENT_AT, ['morning_of', 'evening_before'], NOW)).toEqual([
      '2026-09-21T19:00:00+03:00',
      '2026-09-22T09:00:00+03:00',
    ]);
  });
});
