import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECURRENCE_HOUR,
  Recurrence,
  describeRecurrence,
  nextOccurrence,
  nextOccurrenceAfter,
  normalizeRecurrence,
  untilFromForDays,
} from '../src/reminders/recurrence';

const ZONE = 'Europe/Kyiv';
/** The pinned "now" every acceptance criterion in 0005 uses. A Wednesday, on summer time (+03:00). */
const NOW = new Date('2026-09-16T09:00:00+03:00');

function rule(partial: Partial<Recurrence> & Pick<Recurrence, 'freq'>): Recurrence {
  return { atLocal: '09:00', timezone: ZONE, ...partial };
}

describe('normalizeRecurrence', () => {
  // acceptance: birthday-captured-yearly - a birthday with no clock time becomes a yearly rule
  it('accepts a yearly rule and defaults an all-day event to 09:00 local', () => {
    expect(normalizeRecurrence({ freq: 'yearly', month: 6, day: 12 }, ZONE)).toEqual({
      freq: 'yearly',
      month: 6,
      day: 12,
      atLocal: '09:00',
      timezone: ZONE,
    });
    expect(DEFAULT_RECURRENCE_HOUR).toBe(9);
  });

  // acceptance: weekly-recurrence
  it('accepts a weekly rule with a stated time', () => {
    expect(normalizeRecurrence({ freq: 'weekly', weekday: 'Monday', atLocal: '8:00' }, ZONE)).toEqual(
      { freq: 'weekly', weekday: 'monday', atLocal: '08:00', timezone: ZONE },
    );
  });

  it('keeps only the fields the frequency uses', () => {
    const daily = normalizeRecurrence({ freq: 'daily', month: 6, day: 12, weekday: 'monday' }, ZONE);

    expect(daily).toEqual({ freq: 'daily', atLocal: '09:00', timezone: ZONE });
    expect(daily).not.toHaveProperty('day');
    expect(daily).not.toHaveProperty('weekday');
  });

  // Invariant: recurrence is never invented. Half a rule is dropped, not completed by guessing.
  it('rejects a rule it cannot resolve rather than repairing it', () => {
    for (const bad of [
      undefined,
      null,
      'every monday',
      {},
      { freq: 'fortnightly' },
      { freq: 'weekly' },
      { freq: 'weekly', weekday: 'someday' },
      { freq: 'monthly' },
      { freq: 'monthly', day: 0 },
      { freq: 'monthly', day: 32 },
      { freq: 'yearly', day: 12 },
      { freq: 'yearly', month: 13, day: 1 },
      // 31 June does not exist, so this is a garbled rule, not a clampable one.
      { freq: 'yearly', month: 6, day: 31 },
    ]) {
      expect(normalizeRecurrence(bad, ZONE)).toBeUndefined();
    }
  });

  it('allows 29 February as a yearly rule', () => {
    expect(normalizeRecurrence({ freq: 'yearly', month: 2, day: 29 }, ZONE)?.day).toBe(29);
  });

  it('falls back to 09:00 for an unusable time of day, never to an invented hour', () => {
    for (const bad of [undefined, '', 'morning', '25:00', '09:60', '9', 7]) {
      expect(normalizeRecurrence({ freq: 'daily', atLocal: bad }, ZONE)?.atLocal).toBe('09:00');
    }
  });
});

describe('nextOccurrence', () => {
  // acceptance (unit half): the resolver for daily/weekly/monthly/yearly
  it('resolves a daily rule to today when it is still ahead, otherwise tomorrow', () => {
    const daily = rule({ freq: 'daily', atLocal: '08:00' });

    expect(nextOccurrence(daily, new Date('2026-09-16T07:00:00+03:00'))).toBe(
      '2026-09-16T08:00:00+03:00',
    );
    expect(nextOccurrence(daily, NOW)).toBe('2026-09-17T08:00:00+03:00');
  });

  // acceptance: weekly-recurrence - Wednesday "every Monday at 8am" -> the following Monday
  it('resolves a weekly rule to the next matching weekday', () => {
    expect(nextOccurrence(rule({ freq: 'weekly', weekday: 'monday', atLocal: '08:00' }), NOW)).toBe(
      '2026-09-21T08:00:00+03:00',
    );
  });

  it('resolves a monthly rule, clamping a day the month does not have', () => {
    expect(nextOccurrence(rule({ freq: 'monthly', day: 1 }), NOW)).toBe('2026-10-01T09:00:00+03:00');
    // "the 31st of each month" fires on 30 June rather than skipping June entirely.
    expect(
      nextOccurrence(rule({ freq: 'monthly', day: 31 }), new Date('2026-06-02T09:00:00+03:00')),
    ).toBe('2026-06-30T09:00:00+03:00');
  });

  // acceptance: birthday-captured-yearly - June 12 has passed in 2026, so the next one is 2027
  it('resolves a yearly rule to the next year when this year has passed', () => {
    expect(nextOccurrence(rule({ freq: 'yearly', month: 6, day: 12 }), NOW)).toBe(
      '2027-06-12T09:00:00+03:00',
    );
  });

  it('is inclusive of an occurrence exactly at "now"', () => {
    expect(nextOccurrence(rule({ freq: 'daily' }), NOW)).toBe('2026-09-16T09:00:00+03:00');
  });

  it('returns nothing for an unresolvable timezone instead of guessing UTC', () => {
    expect(nextOccurrence({ ...rule({ freq: 'daily' }), timezone: 'Not/AZone' }, NOW)).toBeUndefined();
  });
});

describe('nextOccurrence across a DST boundary', () => {
  // acceptance: recurrence-dst-winter - the SAME 10:00 rule resolves to +03:00 in summer and
  // +02:00 in winter. This is the whole reason the rule is stored as wall-clock plus timezone.
  it('applies the offset of the occurrence, not of today', () => {
    const tenAm = rule({ freq: 'yearly', month: 12, day: 25, atLocal: '10:00' });

    expect(nextOccurrence(tenAm, NOW)).toBe('2026-12-25T10:00:00+02:00');
    expect(nextOccurrence(rule({ freq: 'yearly', month: 7, day: 25, atLocal: '10:00' }), NOW)).toBe(
      '2027-07-25T10:00:00+03:00',
    );
  });

  it('keeps a daily rule on the same wall clock over the night the zone changes offset', () => {
    // Kyiv leaves summer time at 04:00 local on 2026-10-25. 09:00 stays 09:00; the instant moves.
    expect(
      nextOccurrence(rule({ freq: 'daily' }), new Date('2026-10-24T12:00:00+03:00')),
    ).toBe('2026-10-25T09:00:00+02:00');
  });

  it('keeps a weekly rule on the same wall clock over the same boundary', () => {
    expect(
      nextOccurrence(
        rule({ freq: 'weekly', weekday: 'sunday', atLocal: '08:00' }),
        new Date('2026-10-20T12:00:00+03:00'),
      ),
    ).toBe('2026-10-25T08:00:00+02:00');
  });

  it('clamps 29 February to the 28th in a common year, with that date\'s winter offset', () => {
    expect(nextOccurrence(rule({ freq: 'yearly', month: 2, day: 29 }), NOW)).toBe(
      '2027-02-28T09:00:00+02:00',
    );
  });
});

describe('nextOccurrenceAfter', () => {
  // acceptance: recurrence-rolls-forward - measured from the occurrence that fired, so the 2027
  // birthday rolls to 2028 even though the tick ran at 08:50, before that occurrence's 09:00.
  it('skips the occurrence it is given and returns the following one', () => {
    const birthday = rule({ freq: 'yearly', month: 6, day: 12 });
    const fired = new Date('2027-06-12T09:00:00+03:00');

    expect(nextOccurrenceAfter(birthday, fired)).toBe('2028-06-12T09:00:00+03:00');
    // The contrast that makes the distinction load-bearing: from the tick's own "now" (10 minutes
    // early) an at-or-after search hands back the occurrence that just fired.
    expect(nextOccurrence(birthday, new Date('2027-06-12T08:50:00+03:00'))).toBe(
      '2027-06-12T09:00:00+03:00',
    );
  });

  it('advances daily and weekly rules by exactly one period', () => {
    expect(nextOccurrenceAfter(rule({ freq: 'daily' }), NOW)).toBe('2026-09-17T09:00:00+03:00');
    expect(
      nextOccurrenceAfter(
        rule({ freq: 'weekly', weekday: 'monday', atLocal: '08:00' }),
        new Date('2026-09-21T08:00:00+03:00'),
      ),
    ).toBe('2026-09-28T08:00:00+03:00');
  });
});

describe('describeRecurrence', () => {
  // acceptance: recurrence-humanised - each frequency renders in Ukrainian, time via humanizeTimeOfDay
  it('renders each frequency in Ukrainian for a reply', () => {
    expect(describeRecurrence(rule({ freq: 'daily', atLocal: '20:00' }))).toBe('щодня о 20:00');
    expect(describeRecurrence(rule({ freq: 'weekly', weekday: 'monday', atLocal: '08:00' }))).toBe(
      'щопонеділка о 8:00',
    );
    expect(describeRecurrence(rule({ freq: 'monthly', day: 1 }))).toBe('щомісяця 1 числа о 9:00');
    expect(describeRecurrence(rule({ freq: 'yearly', month: 6, day: 12 }))).toBe(
      'щороку 12 червня о 9:00',
    );
  });

  it('names every weekday', () => {
    const expected: Record<string, string> = {
      monday: 'щопонеділка',
      tuesday: 'щовівторка',
      wednesday: 'щосереди',
      thursday: 'щочетверга',
      friday: "щоп'ятниці",
      saturday: 'щосуботи',
      sunday: 'щонеділі',
    };

    for (const [weekday, word] of Object.entries(expected)) {
      expect(
        describeRecurrence(rule({ freq: 'weekly', weekday: weekday as never, atLocal: '08:00' })),
      ).toBe(`${word} о 8:00`);
    }
  });
});

describe('recurrence end (BUG-0008)', () => {
  /** "every day at 7 for the next 14 days", asked on 2026-11-05: the 14th occurrence is the 19th. */
  const CERT = rule({ freq: 'daily', atLocal: '07:00', until: '2026-11-19' });

  // acceptance: unit-stops-at-until - `until` is inclusive: the 19th still fires, nothing after it
  it('stops a daily rule after its inclusive until date', () => {
    expect(nextOccurrenceAfter(CERT, new Date('2026-11-18T07:00:00+02:00'))).toBe(
      '2026-11-19T07:00:00+02:00',
    );
    expect(nextOccurrenceAfter(CERT, new Date('2026-11-19T07:00:00+02:00'))).toBeUndefined();
    expect(nextOccurrence(CERT, new Date('2026-11-19T07:30:00+02:00'))).toBeUndefined();
  });

  it('has no first occurrence when until is before it', () => {
    expect(nextOccurrence(CERT, new Date('2026-11-20T06:00:00+02:00'))).toBeUndefined();
    expect(
      nextOccurrence(
        rule({ freq: 'yearly', month: 6, day: 12, until: '2027-06-11' }),
        new Date('2026-11-05T12:00:00+02:00'),
      ),
    ).toBeUndefined();
  });

  it('judges until against the occurrence\'s local date, not its UTC date', () => {
    // 00:30 Kyiv on the 19th is still the 18th in UTC; the local date is what counts.
    const night = rule({ freq: 'daily', atLocal: '00:30', until: '2026-11-19' });

    expect(nextOccurrenceAfter(night, new Date('2026-11-18T00:30:00+02:00'))).toBe(
      '2026-11-19T00:30:00+02:00',
    );
    expect(nextOccurrenceAfter(night, new Date('2026-11-19T00:30:00+02:00'))).toBeUndefined();
  });

  it('keeps a valid until when validating, including a stored rule with no evidence', () => {
    expect(
      normalizeRecurrence({ freq: 'daily', atLocal: '07:00', until: '2026-11-19' }, ZONE),
    ).toEqual({ freq: 'daily', atLocal: '07:00', timezone: ZONE, until: '2026-11-19' });
  });

  // Absent stays absent; a bad until is dropped like any other bad field, never repaired.
  it('leaves until absent when none or an unusable one was given', () => {
    for (const bad of [undefined, '', '19 листопада', '2026-13-01', '2026-02-30', '2026-11-19T07:00', 20261119]) {
      const normalized = normalizeRecurrence({ freq: 'daily', until: bad }, ZONE);
      expect(normalized).toEqual({ freq: 'daily', atLocal: '09:00', timezone: ZONE });
      expect(normalized).not.toHaveProperty('until');
    }
  });

  it('never stores forDays', () => {
    expect(normalizeRecurrence({ freq: 'daily', forDays: 14 }, ZONE)).not.toHaveProperty('forDays');
  });

  // acceptance: repro-fixed - "for N days, every day" is exactly N occurrences, counted from the
  // FIRST occurrence (tomorrow 07:00 here, since 07:00 today has passed).
  it('converts forDays to the local date of the first occurrence plus forDays - 1', () => {
    const daily = rule({ freq: 'daily', atLocal: '07:00' });
    const asked = new Date('2026-11-05T11:48:00+02:00');

    expect(untilFromForDays(daily, 14, asked)).toBe('2026-11-19');
    expect(untilFromForDays(daily, 1, asked)).toBe('2026-11-06');
    // Before 07:00 the first occurrence is today.
    expect(untilFromForDays(daily, 14, new Date('2026-11-05T06:00:00+02:00'))).toBe('2026-11-18');
  });

  it('counts calendar days across a DST change, not 24-hour blocks', () => {
    // Kyiv leaves summer time on 2026-10-25; a 00:30 rule would drift a day with 24h arithmetic.
    const night = rule({ freq: 'daily', atLocal: '00:30' });

    expect(untilFromForDays(night, 14, new Date('2026-10-20T12:00:00+03:00'))).toBe('2026-11-03');
  });

  it('refuses a forDays that is not a positive integer', () => {
    const daily = rule({ freq: 'daily', atLocal: '07:00' });
    for (const bad of [0, -3, 1.5, Number.NaN, '14', undefined, null]) {
      expect(untilFromForDays(daily, bad, NOW)).toBeUndefined();
    }
  });

  // The reply shows the end was understood, through the same month-genitive rendering.
  it('appends the end to the Ukrainian description', () => {
    expect(describeRecurrence(CERT)).toBe('щодня о 7:00 до 19 листопада');
    expect(describeRecurrence(rule({ freq: 'daily', atLocal: '21:00', until: '2026-12-01' }))).toBe(
      'щодня о 21:00 до 1 грудня',
    );
    expect(describeRecurrence(rule({ freq: 'daily', atLocal: '07:00' }))).toBe('щодня о 7:00');
  });
});
