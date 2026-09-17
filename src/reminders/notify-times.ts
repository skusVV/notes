import { DateTime } from 'luxon';
import { normalizeEventAt } from './event-at';

/** Local hour "morning" resolves to when a notify phrase names no clock time. Fixed for v1. */
export const MORNING_HOUR = 9;
/** Local hour "evening" resolves to. Fixed for v1, same reasoning as {@link MORNING_HOUR}. */
export const EVENING_HOUR = 19;

/**
 * The relative notify phrases the model may return instead of an instant. Deliberately a short,
 * closed set: each one resolves in code against `eventAt`, so "the evening before" means the same
 * thing on every message instead of whatever hour the model felt like that day.
 */
export const RELATIVE_NOTIFY = [
  'morning_of',
  'evening_of',
  'morning_before',
  'evening_before',
  'at_event',
] as const;

export type RelativeNotify = (typeof RELATIVE_NOTIFY)[number];

function isRelative(value: string): value is RelativeNotify {
  return (RELATIVE_NOTIFY as readonly string[]).includes(value);
}

/**
 * Resolves one relative notify phrase against a canonical `eventAt`, in the zone that `eventAt`
 * carries - so "the morning of" is 09:00 where the user is, not 09:00 UTC. Returns the same
 * canonical local-ISO-with-offset form `eventAt` uses, or `undefined` when `eventAt` is unusable.
 *
 * `at_event` is the identity case: it exists so "remind me then" and a message that names no
 * notify time at all both land on exactly one notification at the event instant.
 */
export function resolveRelativeNotify(
  keyword: RelativeNotify,
  canonicalEventAt: string,
): string | undefined {
  const event = DateTime.fromISO(canonicalEventAt, { setZone: true });
  if (!event.isValid) {
    return undefined;
  }

  if (keyword === 'at_event') {
    return canonical(event);
  }

  const dayShift = keyword === 'morning_before' || keyword === 'evening_before' ? -1 : 0;
  const hour = keyword === 'morning_of' || keyword === 'morning_before' ? MORNING_HOUR : EVENING_HOUR;

  return canonical(
    event.plus({ days: dayShift }).set({ hour, minute: 0, second: 0, millisecond: 0 }),
  );
}

/**
 * The instants one reminder should nudge at, from whatever the classifier returned. Each requested
 * entry is either a relative keyword (resolved here) or an ISO 8601 instant with an offset
 * (validated, never guessed); anything else is dropped rather than repaired.
 *
 * The result is de-duplicated and sorted ascending. An entry at or before `now` is dropped, because
 * a notification in the past would fire on the very next sweep instead of when it was meant to.
 * When nothing survives - the common "the user named no notify time" case, and every unresolvable
 * one - the fallback is exactly one notification at `eventAt`, which is the 0002/0003 behaviour.
 */
export function resolveNotifyTimes(
  canonicalEventAt: string,
  requested: string[] | undefined,
  now: Date,
): string[] {
  const resolved = new Set<string>();

  for (const entry of requested ?? []) {
    const value = entry.trim();
    if (!value) {
      continue;
    }

    // Relative keywords are resolved first, then every candidate - resolved or model-supplied -
    // goes through the same normaliser, so the offset requirement and the "must be in the future"
    // rule apply identically to both.
    const candidate = isRelative(value) ? resolveRelativeNotify(value, canonicalEventAt) : value;
    const instant = normalizeEventAt(candidate, now);
    if (instant) {
      resolved.add(instant);
    }
  }

  const times = [...resolved].sort(compareInstants);
  return times.length > 0 ? times : [canonicalEventAt];
}

/** Sort by the instant each string denotes, not by its text - offsets make those differ. */
function compareInstants(a: string, b: string): number {
  return (
    DateTime.fromISO(a, { setZone: true }).toMillis() -
    DateTime.fromISO(b, { setZone: true }).toMillis()
  );
}

/** The one canonical rendering: seconds precision, offset kept, no milliseconds. */
function canonical(dt: DateTime): string | undefined {
  return dt.toISO({ suppressMilliseconds: true, includeOffset: true }) ?? undefined;
}
