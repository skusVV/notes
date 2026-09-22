import { describe, expect, it } from 'vitest';
import { humanizeInstant, humanizeTimeOfDay } from '../src/reminders/humanize-time';

// The pinned "now" the 0008 acceptance criteria use: 2026-09-21, on summer time (+03:00).
const NOW = new Date('2026-09-21T08:00:00+03:00');

describe('humanizeInstant', () => {
  // acceptance: today-form / tomorrow-form-ob / day-after-form
  it('renders the three relative-day forms with the right preposition', () => {
    expect(humanizeInstant('2026-09-21T20:00:00+03:00', NOW)).toBe('Сьогодні о 20:00');
    // Hour 11 takes 'об', not 'о'.
    expect(humanizeInstant('2026-09-22T11:00:00+03:00', NOW)).toBe('Завтра об 11:00');
    // Hour has no leading zero, minutes are always two digits.
    expect(humanizeInstant('2026-09-23T09:30:00+03:00', NOW)).toBe('Післязавтра о 9:30');
  });

  // acceptance: date-form-same-year - four days out is the date form, no year in the current year
  it('renders a date form without the year when it matches now', () => {
    expect(humanizeInstant('2026-09-25T20:00:00+03:00', NOW)).toBe('25 вересня о 20:00');
  });

  // acceptance: date-form-other-year - the year is shown because it differs from now's year
  it('renders a date form with the year when it differs from now', () => {
    const dec = new Date('2026-12-30T08:00:00+02:00');
    expect(humanizeInstant('2027-01-05T08:00:00+02:00', dec)).toBe('5 січня 2027 о 8:00');
  });

  // unit: across the day boundary an event just after midnight is Завтра, not Сьогодні
  it('is Завтра for an event just after midnight seen the previous evening', () => {
    const lateEvening = new Date('2026-09-21T23:50:00+03:00');
    expect(humanizeInstant('2026-09-22T00:10:00+03:00', lateEvening)).toBe('Завтра о 0:10');
  });

  // unit: a past instant is the date form, never Вчора, never Сьогодні for another calendar day
  it('renders a past instant as the date form, never as Вчора', () => {
    const rendered = humanizeInstant('2026-09-20T10:00:00+03:00', NOW);
    expect(rendered).toBe('20 вересня о 10:00');
    expect(rendered).not.toContain('Вчора');
    expect(rendered).not.toContain('Сьогодні');
  });

  // unit: the day is read in the value's OWN offset, regardless of the machine's TZ
  it('reads the calendar day in the value own offset', () => {
    const now = new Date('2026-09-21T23:00:00+03:00');
    expect(humanizeInstant('2026-09-22T00:30:00+03:00', now)).toBe('Завтра о 0:30');
  });

  // unit: never invent a time - an empty, unparseable or offset-less value passes through unchanged
  it('returns an unresolvable value unchanged', () => {
    expect(humanizeInstant('', NOW)).toBe('');
    expect(humanizeInstant('not a date', NOW)).toBe('not a date');
    expect(humanizeInstant('2026-09-21T11:00:00', NOW)).toBe('2026-09-21T11:00:00');
  });

  // unit: capitalize:false lower-cases a word prefix but leaves a date form (starts with a digit)
  it('lower-cases the prefix with capitalize:false, but leaves a date form untouched', () => {
    expect(humanizeInstant('2026-09-22T09:00:00+03:00', NOW, { capitalize: false })).toBe(
      'завтра о 9:00',
    );
    expect(humanizeInstant('2026-09-25T20:00:00+03:00', NOW, { capitalize: false })).toBe(
      '25 вересня о 20:00',
    );
  });
});

describe('humanizeTimeOfDay', () => {
  it('renders a wall-clock time with the right preposition, or passes non-times through', () => {
    expect(humanizeTimeOfDay('11:00')).toBe('об 11:00');
    expect(humanizeTimeOfDay('08:00')).toBe('о 8:00');
    expect(humanizeTimeOfDay('20:00')).toBe('о 20:00');
    expect(humanizeTimeOfDay('abc')).toBe('abc');
  });
});
