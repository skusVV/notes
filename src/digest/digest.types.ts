/**
 * What every digest section is handed. Computed once per digest and identical for all sections, so
 * two sections can never disagree about which day "today" is.
 */
export interface DigestContext {
  userId: number;
  now: Date;
  timezone: string;
  /** Start and end of the local day, computed once and the same for every section. */
  dayStart: Date;
  dayEnd: Date;
}

/** One section's contribution: a heading and its lines. */
export interface DigestSectionResult {
  /** The heading, e.g. 'Нагадування'. */
  title: string;
  /** One entry per line, each without a bullet: the digest adds '• ' itself. */
  lines: string[];
}

/**
 * One part of the morning digest (reminders today; Garmin, calendar and to-do later). The digest
 * knows only this interface, so adding a section is one class implementing it plus one registration
 * line in that section's own module - `DigestService`, `DigestRunnerService` and `/digest` stay as
 * they are.
 */
export interface DigestSection {
  /** Stable identifier for logs and a future "turn section X off". */
  readonly id: string;
  /** Lower comes first in the message. Sections are sorted by this, not by registration order. */
  readonly order: number;
  /**
   * The section's lines without a heading, or null when there is nothing today. null or an empty
   * `lines` means "the section is not shown", never "an empty heading".
   */
  build(ctx: DigestContext): Promise<DigestSectionResult | null>;
}

/**
 * The injection token for the registered sections: a plain `DigestSection[]` owned by
 * `DigestModule`. Nest has no true multi-provider, so a section adds itself to this array from its
 * own module's `onModuleInit` (see `RemindersDigestSection`) and the digest reads it at build time.
 */
export const DIGEST_SECTIONS = Symbol('DIGEST_SECTIONS');
