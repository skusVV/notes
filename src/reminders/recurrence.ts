import { DateTime, WeekdayNumbers } from 'luxon';
import { humanizeTimeOfDay, MONTHS_GENITIVE } from './humanize-time';

/**
 * The recurrence rules v1 understands. Deliberately a short, closed set on a fixed day and time:
 * "every second Tuesday" and "the last day of the month" are out of scope, and a rule the code
 * cannot resolve must never be stored as an approximation of one it can.
 */
export const RECURRENCE_FREQ = ['daily', 'weekly', 'monthly', 'yearly'] as const;

export type RecurrenceFreq = (typeof RECURRENCE_FREQ)[number];

/** Lowercase English weekday names, in luxon's order so the index doubles as its weekday number. */
export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** The local hour an all-day recurring event (a birthday with no stated time) fires at. */
export const DEFAULT_RECURRENCE_HOUR = 9;

const DEFAULT_AT_LOCAL = `${String(DEFAULT_RECURRENCE_HOUR).padStart(2, '0')}:00`;

// 'HH:mm', 24-hour. The stored form is wall-clock only: it carries no date and no offset, which is
// the whole point - see the Recurrence doc comment.
const AT_LOCAL = /^(\d{1,2}):(\d{2})$/;

/**
 * A repeat rule, stored as **local wall-clock plus timezone - never a UTC instant** (the DST rule
 * in docs/architecture.md section 8). "09:00 on June 12" is 06:00 UTC in summer and 07:00 UTC in
 * winter, so an instant would silently shift the user's reminder by an hour twice a year. Each
 * occurrence is resolved from `atLocal` + `timezone` instead, by {@link nextOccurrence}.
 *
 * Only the fields the frequency actually uses are present: a `daily` rule has no `day`, a `weekly`
 * one no `month`. Absent stays absent rather than being filled with a placeholder.
 */
export interface Recurrence {
  freq: RecurrenceFreq;
  /** 1-12. `yearly` only. */
  month?: number;
  /** 1-31 day of month. `monthly` and `yearly` only. */
  day?: number;
  /** `weekly` only. */
  weekday?: Weekday;
  /** 'HH:mm' local wall-clock time. Defaults to 09:00 when the message named no time. */
  atLocal: string;
  /** IANA name the wall-clock time is read in. */
  timezone: string;
}

function isFreq(value: string): value is RecurrenceFreq {
  return (RECURRENCE_FREQ as readonly string[]).includes(value);
}

function isWeekday(value: string): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value);
}

/** Days in a month, judged in a leap year so 29 February is a legal yearly rule. */
function maxDayOfMonth(month: number): number {
  return DateTime.fromObject({ year: 2024, month, day: 1 }).daysInMonth ?? 31;
}

/**
 * Validates a model-supplied repeat rule into a {@link Recurrence}, or `undefined` when it is not
 * a rule this code can resolve. Nothing is repaired or inferred: a `weekly` rule with no weekday,
 * a `yearly` rule with no month, and "31 June" are all rejected rather than guessed at, because an
 * invented recurrence fires forever at a time the user never asked for.
 *
 * The one default applied is the time of day: an all-day recurring event (a birthday) fires at
 * {@link DEFAULT_RECURRENCE_HOUR}, which the spec fixes rather than leaving to the model.
 *
 * `originalText`, when given, gates the rule on `raw.evidence` being real words quoted from the
 * message rather than trusted outright - the model has repeated a "this sounds routine" judgement
 * into a recurrence it was explicitly told not to invent, so the same judgement asking itself
 * "did I quote something real?" is not a safeguard. Omitted when re-validating a rule already read
 * back from storage, which never carried an `evidence` field to check.
 */
export function normalizeRecurrence(
  value: unknown,
  timezone: string,
  originalText?: string,
): Recurrence | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const freq = typeof raw.freq === 'string' ? raw.freq.trim().toLowerCase() : '';
  if (!isFreq(freq)) {
    return undefined;
  }

  if (originalText !== undefined && !isQuotedFrom(raw.evidence, originalText)) {
    return undefined;
  }

  const atLocal = normalizeAtLocal(raw.atLocal) ?? DEFAULT_AT_LOCAL;
  const zone = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'UTC';
  const base = { freq, atLocal, timezone: zone };

  if (freq === 'daily') {
    return base;
  }

  if (freq === 'weekly') {
    const weekday = typeof raw.weekday === 'string' ? raw.weekday.trim().toLowerCase() : '';
    return isWeekday(weekday) ? { ...base, weekday } : undefined;
  }

  const day = wholeNumber(raw.day);
  if (day === undefined || day < 1 || day > 31) {
    return undefined;
  }

  if (freq === 'monthly') {
    return { ...base, day };
  }

  const month = wholeNumber(raw.month);
  if (month === undefined || month < 1 || month > 12 || day > maxDayOfMonth(month)) {
    return undefined;
  }

  return { ...base, month, day };
}

/** 'HH:mm' in range, or `undefined` - which the caller turns into the 09:00 default. */
function normalizeAtLocal(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = AT_LOCAL.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return undefined;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** A verbatim substring check, not a semantic one: it can't tell a real quote from a coincidental
 * one, but it does make bare invention impossible - the model must ground its claim in text that
 * is actually there. */
function isQuotedFrom(evidence: unknown, originalText: string): boolean {
  if (typeof evidence !== 'string' || !evidence.trim()) {
    return false;
  }
  return originalText.toLowerCase().includes(evidence.trim().toLowerCase());
}

function wholeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.round(value);
}

/**
 * The first occurrence of `recurrence` at or after `from`, as the same canonical local-ISO-with-
 * offset string `eventAt` and a notification's `atLocal` use, e.g. `2027-06-12T09:00:00+03:00`.
 * `undefined` when the rule or its timezone cannot be resolved (never a guessed time).
 *
 * The offset comes out of the *occurrence's* own date, not out of today's: a yearly 10:00 rule
 * resolves to `+03:00` in July and `+02:00` on 25 December in Europe/Kyiv. That is the DST
 * correctness this whole shape exists for.
 */
export function nextOccurrence(recurrence: Recurrence, from: Date): string | undefined {
  return resolve(recurrence, from, false);
}

/**
 * The occurrence strictly **after** `instant` - what the sweeper arms once an occurrence has fired.
 * It cannot use {@link nextOccurrence} from "now": a tick runs up to one interval *before* the
 * occurrence it delivers, so "at or after now" would hand back the occurrence that just fired and
 * the reminder would never move forward.
 */
export function nextOccurrenceAfter(recurrence: Recurrence, instant: Date): string | undefined {
  return resolve(recurrence, instant, true);
}

function resolve(recurrence: Recurrence, from: Date, strict: boolean): string | undefined {
  const start = DateTime.fromJSDate(from).setZone(recurrence.timezone);
  if (!start.isValid) {
    return undefined;
  }

  const [hour, minute] = recurrence.atLocal.split(':').map(Number);
  const at = { hour, minute, second: 0, millisecond: 0 };

  let candidate: DateTime;
  let step: (dt: DateTime) => DateTime;

  switch (recurrence.freq) {
    case 'daily':
      candidate = start.set(at);
      step = (dt) => dt.plus({ days: 1 }).set(at);
      break;
    case 'weekly': {
      // set({ weekday }) moves inside the current ISO week (Monday-Sunday), so the first candidate
      // can be behind `from`; the step below walks it forward.
      const weekday = (WEEKDAYS.indexOf(recurrence.weekday ?? 'monday') + 1) as WeekdayNumbers;
      candidate = start.set({ weekday, ...at });
      step = (dt) => dt.plus({ weeks: 1 }).set(at);
      break;
    }
    case 'monthly':
      candidate = onDayOfMonth(start, recurrence.day ?? 1, at);
      step = (dt) => onDayOfMonth(dt.plus({ months: 1 }), recurrence.day ?? 1, at);
      break;
    case 'yearly':
      candidate = onDayOfMonth(start.set({ month: recurrence.month ?? 1, day: 1 }), recurrence.day ?? 1, at);
      step = (dt) =>
        onDayOfMonth(dt.plus({ years: 1 }).set({ month: recurrence.month ?? 1, day: 1 }), recurrence.day ?? 1, at);
      break;
  }

  // At most one step is ever needed, but the loop is bounded rather than assumed: a clamped day
  // (29 February in a common year) can land the first candidate before `from` after stepping too.
  for (let guard = 0; guard < 8; guard += 1) {
    if (!candidate.isValid) {
      return undefined;
    }
    if (isAtOrAfter(candidate, from, strict)) {
      return candidate.toISO({ suppressMilliseconds: true, includeOffset: true }) ?? undefined;
    }
    candidate = step(candidate);
  }

  return undefined;
}

/**
 * `day` in the month `dt` is in, clamped to that month's length: a "31st of each month" rule fires
 * on 30 June and 28 February rather than skipping those months entirely. Clamping keeps the
 * "exactly one scheduled occurrence" invariant simple - a skipped month would need a second search.
 */
function onDayOfMonth(
  dt: DateTime,
  day: number,
  at: { hour: number; minute: number; second: number; millisecond: number },
): DateTime {
  const days = dt.daysInMonth ?? 31;
  return dt.set({ day: Math.min(day, days), ...at });
}

function isAtOrAfter(candidate: DateTime, from: Date, strict: boolean): boolean {
  const diff = candidate.toMillis() - from.getTime();
  return strict ? diff > 0 : diff >= 0;
}

/**
 * A one-line Ukrainian rendering of a rule for a reply ("щороку 12 червня о 9:00"). Reply wording
 * only - never parsed back, and never the stored form. The time goes through humanizeTimeOfDay so
 * the same 'о'/'об' rule as every other reply applies.
 */
export function describeRecurrence(recurrence: Recurrence): string {
  const at = ` ${humanizeTimeOfDay(recurrence.atLocal)}`;
  switch (recurrence.freq) {
    case 'daily':
      return `щодня${at}`;
    case 'weekly':
      return `${WEEKDAYS_UK[recurrence.weekday ?? 'monday']}${at}`;
    case 'monthly':
      return `щомісяця ${recurrence.day} числа${at}`;
    case 'yearly':
      return `щороку ${recurrence.day} ${MONTHS_GENITIVE[(recurrence.month ?? 1) - 1]}${at}`;
  }
}

/** How each weekday reads in "every <weekday>": genitive/adverbial forms after "що". */
const WEEKDAYS_UK: Record<Weekday, string> = {
  monday: 'щопонеділка',
  tuesday: 'щовівторка',
  wednesday: 'щосереди',
  thursday: 'щочетверга',
  friday: "щоп'ятниці",
  saturday: 'щосуботи',
  sunday: 'щонеділі',
};
