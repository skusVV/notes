import { DateTime } from 'luxon';

/**
 * Ukrainian month names in the genitive case, index 0-11 (`січня` = January). The genitive is the
 * form a date takes in "25 вересня" ("the 25th of September"), so this is what the date form uses.
 */
export const MONTHS_GENITIVE = [
  'січня',
  'лютого',
  'березня',
  'квітня',
  'травня',
  'червня',
  'липня',
  'серпня',
  'вересня',
  'жовтня',
  'листопада',
  'грудня',
] as const;

// A value only pins a real instant if it carries an offset (Z or +hh:mm); the same discipline as
// event-at.ts. Without one the string means a different moment in every zone, so this code refuses
// to render it as a relative day and passes it through unchanged instead.
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

// A bare wall-clock time, 'H:mm' or 'HH:mm', 24-hour. The only shape humanizeTimeOfDay renders.
const TIME_OF_DAY = /^(\d{1,2}):(\d{2})$/;

/** 'об' before hour 11 (об одинадцятій), 'о' otherwise (о двадцятій). */
function preposition(hour: number): string {
  return hour === 11 ? 'об' : 'о';
}

/** 'H:mm' - hour with no leading zero, minutes always two digits. */
function timeOfDay(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, '0')}`;
}

/**
 * An ISO instant rendered as a Ukrainian phrase relative to `now`:
 * 'Сьогодні о 20:00' | 'Завтра об 11:00' | 'Післязавтра о 9:30' | '25 вересня о 20:00'
 * | '5 січня 2027 о 8:00'
 *
 * The calendar day is read in the value's **own** offset, and `now` is converted into that same
 * zone before the two days are compared - the stored offset is the zone the user meant, and the
 * server's zone is never used. A value this code cannot resolve (empty, unparseable, or offset-less)
 * is returned unchanged, the same "never invent a time" discipline as normalizeEventAt.
 */
export function humanizeInstant(
  iso: string,
  now: Date,
  options?: { capitalize?: boolean },
): string {
  const value = iso?.trim();
  if (!value || !HAS_OFFSET.test(value)) {
    return iso;
  }

  const target = DateTime.fromISO(value, { setZone: true });
  if (!target.isValid) {
    return iso;
  }

  // Read "now" in the value's own zone, so "today" is decided the way the user meant it.
  const nowInZone = DateTime.fromJSDate(now).setZone(target.zone);
  const dayDiff = Math.round(
    target.startOf('day').diff(nowInZone.startOf('day'), 'days').days,
  );

  const time = `${preposition(target.hour)} ${timeOfDay(target.hour, target.minute)}`;

  let prefix: string;
  if (dayDiff === 0) {
    prefix = 'Сьогодні';
  } else if (dayDiff === 1) {
    prefix = 'Завтра';
  } else if (dayDiff === 2) {
    prefix = 'Післязавтра';
  } else {
    // Everything else - including a negative difference (a late delivery) - is the date form. The
    // year is shown only when it differs from now's year in this same zone.
    const date = `${target.day} ${MONTHS_GENITIVE[target.month - 1]}`;
    prefix = target.year === nowInZone.year ? date : `${date} ${target.year}`;
  }

  const phrase = `${prefix} ${time}`;
  const capitalize = options?.capitalize ?? true;
  // A date form starts with a digit, so lower-casing its first character is a no-op; only the
  // Сьогодні/Завтра/Післязавтра prefixes are affected, letting the phrase sit inside a sentence.
  return capitalize ? phrase : phrase.charAt(0).toLowerCase() + phrase.slice(1);
}

/** 'HH:mm' (or 'H:mm') wall-clock -> 'о 20:00' | 'об 11:00'. Input passed through if it does not match. */
export function humanizeTimeOfDay(atLocal: string): string {
  const match = TIME_OF_DAY.exec(atLocal ?? '');
  if (!match) {
    return atLocal;
  }

  const hour = Number(match[1]);
  return `${preposition(hour)} ${hour}:${match[2]}`;
}
