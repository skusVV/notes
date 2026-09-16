import { DateTime } from 'luxon';

/** How long after the event a stored reminder lingers before the TTL policy reaps it. */
export const EXPIRE_HOURS = 24;

// An eventAt only pins a real moment if it carries an offset. Without one the same string means a
// different instant in every zone, so a model reply that "forgot" the offset is rejected rather
// than silently resolved against the server's zone.
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Validates and normalises an `eventAt` to the canonical form `YYYY-MM-DDThh:mm:ss` + offset
 * (seconds precision, no milliseconds), e.g. `2026-09-17T12:00:00+03:00`. Returns `undefined`
 * when the value is missing, unparseable, offset-less, or not strictly after `now` - the "no
 * resolvable future time" case both the classifier (drop confidence) and the reminders service
 * (no write) treat as unresolved. Never invents a time.
 */
export function normalizeEventAt(eventAt: string | undefined, now: Date): string | undefined {
  const value = eventAt?.trim();
  if (!value || !HAS_OFFSET.test(value)) {
    return undefined;
  }

  const dt = DateTime.fromISO(value, { setZone: true });
  if (!dt.isValid) {
    return undefined;
  }

  // A reminder in the past is not actionable; the classifier resolves "the 25th" forward, so a
  // past instant means the resolution failed and the caller should ask rather than store.
  if (dt.toMillis() <= now.getTime()) {
    return undefined;
  }

  // Truncate to seconds so any input precision collapses to the one canonical form.
  return dt.set({ millisecond: 0 }).toISO({ suppressMilliseconds: true, includeOffset: true }) ?? undefined;
}

/**
 * The instant a stored reminder expires: the event time plus {@link EXPIRE_HOURS}. Kept alongside
 * normalisation so the TTL field is computed from the same canonical value that is stored.
 */
export function computeExpireAt(canonicalEventAt: string): Date {
  return DateTime.fromISO(canonicalEventAt, { setZone: true })
    .plus({ hours: EXPIRE_HOURS })
    .toJSDate();
}
