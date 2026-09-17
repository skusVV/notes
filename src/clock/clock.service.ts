import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

// An ISO 8601 value only counts as pinning an instant if it carries an offset (Z or +hh:mm),
// otherwise the same string means a different moment in every reader's zone. The test-only
// X-Test-Now header is required to carry one, so an offset-less value is treated as absent.
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * The single source of "now". Everything that needs the current instant goes through here so a
 * test can pin it: the request-scoped override (from the X-Test-Now header on the test function)
 * makes relative-date resolution deterministic without a real wall clock.
 */
@Injectable()
export class ClockService {
  /**
   * The current instant, or `overrideIso` when it is a valid ISO 8601 string with an offset.
   * An invalid, offset-less, or absent override falls through to the real clock, so production -
   * which never sets one - is unaffected.
   */
  now(overrideIso?: string): Date {
    const value = overrideIso?.trim();
    if (value && HAS_OFFSET.test(value)) {
      const parsed = DateTime.fromISO(value, { setZone: true });
      if (parsed.isValid) {
        return parsed.toJSDate();
      }
    }
    return new Date();
  }

  /**
   * Formats an instant as a local-time ISO string with offset for a given IANA timezone, e.g.
   * `2026-09-16T09:00:00+03:00` - the form the classifier prompt states as "now" and the form
   * `eventAt` and a notification's `atLocal` are stored and exported in. Seconds precision, no milliseconds. An
   * unknown zone degrades to UTC rather than throwing.
   */
  formatLocal(instant: Date, timezone: string): string {
    const local = DateTime.fromJSDate(instant).setZone(timezone);
    const dt = (local.isValid ? local : DateTime.fromJSDate(instant).setZone('UTC')).set({
      millisecond: 0,
    });
    return dt.toISO({ suppressMilliseconds: true, includeOffset: true }) ?? instant.toISOString();
  }

  /**
   * `instant` shifted forward by whole hours - the `+1h` snooze target. A fixed duration, so it is
   * zone-independent: an hour is an hour even across a DST boundary.
   */
  plusHours(instant: Date, hours: number): Date {
    return DateTime.fromJSDate(instant).plus({ hours }).toJSDate();
  }

  /**
   * The next calendar day after `instant`, at `hour`:00 local time in `timezone` - the `Tomorrow`
   * snooze target. "Next calendar day" is decided in that zone, not in UTC, and the resulting
   * instant carries whatever offset the zone is on that day, so a jump across a DST change still
   * lands on 09:00 wall-clock. An unknown zone degrades to UTC rather than throwing.
   */
  nextDayAt(instant: Date, timezone: string, hour: number): Date {
    const local = DateTime.fromJSDate(instant).setZone(timezone);
    const base = local.isValid ? local : DateTime.fromJSDate(instant).setZone('UTC');
    return base
      .plus({ days: 1 })
      .set({ hour, minute: 0, second: 0, millisecond: 0 })
      .toJSDate();
  }
}
