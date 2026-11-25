import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the model off the network: GoogleGenAI is stubbed so generateContent returns a canned reply,
// and Type carries the enum members RESPONSE_SCHEMA references at module load. The `mock` prefix is
// what lets vitest reference this from the hoisted vi.mock factory.
const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
  Type: {
    OBJECT: 'OBJECT',
    STRING: 'STRING',
    ARRAY: 'ARRAY',
    NUMBER: 'NUMBER',
    INTEGER: 'INTEGER',
    BOOLEAN: 'BOOLEAN',
  },
}));

import { ClassifierService } from '../src/classifier/classifier.service';
import { CONFIDENCE_ASK, ClassifierContext } from '../src/classifier/classifier.types';

const NOW = '2026-09-16T09:00:00+03:00';

function makeClassifier(): ClassifierService {
  const config = {
    get: (key: string): string | undefined =>
      key === 'GCP_PROJECT' ? 'test-project' : key === 'DEFAULT_TIMEZONE' ? 'Europe/Kyiv' : undefined,
  };
  return new ClassifierService(config as never);
}

function replyWithReminder(confidence: number, reminder: Record<string, unknown> | undefined): void {
  const item: Record<string, unknown> = { intent: 'reminder', confidence, summary: 'a reminder' };
  if (reminder) {
    item.reminder = reminder;
  }
  mockGenerateContent.mockResolvedValueOnce({
    text: JSON.stringify({ language: 'en', mentions: [], keywords: [], items: [item] }),
  });
}

const context: ClassifierContext = { timezone: 'Europe/Kyiv', now: NOW };

describe('ClassifierService reminder validation', () => {
  let classifier: ClassifierService;

  beforeEach(() => {
    mockGenerateContent.mockReset();
    classifier = makeClassifier();
  });

  // acceptance: reminder-stored (a resolvable reminder stays actionable)
  it('keeps confidence for a reminder with a resolvable future eventAt and a stated time', async () => {
    replyWithReminder(0.95, {
      title: 'haircut',
      eventAt: '2026-09-17T12:00:00+03:00',
      hasTimeOfDay: true,
    });

    const result = await classifier.classify('haircut on Thursday at 12', context);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].confidence).toBe(0.95);
    expect(result.items[0].confidence).toBeGreaterThanOrEqual(CONFIDENCE_ASK);
  });

  // acceptance: missing-time-not-stored (no time -> pushed below ASK -> clarify, never stored)
  it('forces confidence below CONFIDENCE_ASK when eventAt is absent', async () => {
    replyWithReminder(0.95, { title: 'call the doctor', hasTimeOfDay: false });

    const result = await classifier.classify('remind me to call the doctor on Thursday', context);

    expect(result.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
  });

  // acceptance: missing-time-not-stored (the live bug: model names a date but no time and copies
  // the clock from "now", yielding a valid-but-fabricated instant). hasTimeOfDay=false is the
  // deterministic signal that drops it to clarify even though eventAt parses as a real future time.
  it('forces confidence below CONFIDENCE_ASK when a date is given but no time of day', async () => {
    replyWithReminder(0.95, {
      title: 'call the doctor',
      // A fabricated-but-valid future instant (the hour copied from "now").
      eventAt: '2026-09-17T09:00:00+03:00',
      hasTimeOfDay: false,
    });

    const result = await classifier.classify('remind me on Thursday to call the doctor', context);

    expect(result.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
  });

  it('forces confidence below CONFIDENCE_ASK when eventAt is in the past', async () => {
    replyWithReminder(0.95, {
      title: 'old thing',
      eventAt: '2026-09-15T12:00:00+03:00',
      hasTimeOfDay: true,
    });

    const result = await classifier.classify('remind me yesterday', context);

    expect(result.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
  });

  // acceptance: two-notifications-captured - both notify phrases survive to the reminder draft
  it('carries every requested notify time through to the draft', async () => {
    replyWithReminder(0.95, {
      title: 'doctor appointment',
      eventAt: '2026-09-22T14:00:00+03:00',
      hasTimeOfDay: true,
      notifyAt: ['evening_before', 'morning_of'],
    });

    const result = await classifier.classify(
      'I have a doctor appointment on the 22nd at 2PM, remind me the evening before and the morning of',
      context,
    );

    expect(result.items[0].reminder?.notifyAt).toEqual(['evening_before', 'morning_of']);
  });

  // acceptance: single-default-notification - no notify phrasing leaves the field absent, which
  // the store resolves to exactly one notification at eventAt
  it('leaves notifyAt absent when the model returned none or an unusable one', async () => {
    for (const notifyAt of [undefined, [], ['  '], 'not an array', [7]]) {
      replyWithReminder(0.95, {
        title: 'pay rent',
        eventAt: '2026-09-25T12:00:00+03:00',
        hasTimeOfDay: true,
        notifyAt,
      });

      const result = await classifier.classify('Remind me on the 25th at 12 to pay rent', context);

      expect(result.items[0].reminder?.notifyAt).toBeUndefined();
    }
  });

  // acceptance: birthday-captured-yearly - a birthday states no clock time and no eventAt, so only
  // a valid recurrence can make it actionable. Without this it would land in the clarify branch and
  // never be stored.
  it('keeps confidence for a recurring reminder with no eventAt and no time of day', async () => {
    replyWithReminder(0.95, {
      title: "Bob's birthday",
      hasTimeOfDay: false,
      recurrence: { freq: 'yearly', month: 6, day: 12, evidence: 'birthday on June 12' },
    });

    const result = await classifier.classify('Bob has a birthday on June 12', context);

    expect(result.items[0].confidence).toBe(0.95);
    // The 09:00 default and the user's timezone are filled in by code, not by the model.
    expect(result.items[0].reminder?.recurrence).toEqual({
      freq: 'yearly',
      month: 6,
      day: 12,
      atLocal: '09:00',
      timezone: 'Europe/Kyiv',
    });
  });

  // acceptance: weekly-recurrence - the stated time survives as wall-clock, not as an instant
  it('carries a weekly rule and its stated time through to the draft', async () => {
    replyWithReminder(0.95, {
      title: 'take out the trash',
      hasTimeOfDay: true,
      recurrence: { freq: 'weekly', weekday: 'monday', atLocal: '08:00', evidence: 'every Monday' },
    });

    const result = await classifier.classify('Take out the trash every Monday at 8am', context);

    expect(result.items[0].reminder?.recurrence).toEqual({
      freq: 'weekly',
      weekday: 'monday',
      atLocal: '08:00',
      timezone: 'Europe/Kyiv',
    });
  });

  // Invariant: a recurrence is never invented. A one-off stays a one-off.
  it('leaves recurrence absent when the model returned none', async () => {
    replyWithReminder(0.95, {
      title: 'haircut',
      eventAt: '2026-09-17T12:00:00+03:00',
      hasTimeOfDay: true,
    });

    const result = await classifier.classify('haircut on Thursday at 12', context);

    expect(result.items[0].reminder?.recurrence).toBeUndefined();
  });

  // A half-stated rule is dropped rather than completed, and the reminder then has to stand on its
  // eventAt like any other - here there is none, so it drops to clarify instead of being stored as
  // a repeat at a guessed weekday.
  it('drops an unresolvable rule and falls back to the eventAt requirement', async () => {
    replyWithReminder(0.95, {
      title: 'something weekly',
      hasTimeOfDay: false,
      recurrence: { freq: 'weekly' },
    });

    const result = await classifier.classify('remind me weekly', context);

    expect(result.items[0].reminder?.recurrence).toBeUndefined();
    expect(result.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
  });

  it('forces confidence below CONFIDENCE_ASK when eventAt carries no offset', async () => {
    replyWithReminder(0.95, {
      title: 'ambiguous',
      eventAt: '2026-09-17T12:00:00',
      hasTimeOfDay: true,
    });

    const result = await classifier.classify('remind me Thursday noon', context);

    expect(result.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
  });
});

describe('ClassifierService allDay flag (0023)', () => {
  let classifier: ClassifierService;

  beforeEach(() => {
    mockGenerateContent.mockReset();
    classifier = makeClassifier();
  });

  // acceptance: birthday-shown-without-time - set by code from hasTimeOfDay === false
  it('sets allDay for a valid recurrence with hasTimeOfDay === false', async () => {
    replyWithReminder(0.95, {
      title: "Bob's birthday",
      hasTimeOfDay: false,
      recurrence: { freq: 'yearly', month: 10, day: 14, evidence: 'birthday on October 14' },
    });

    const result = await classifier.classify('Bob has a birthday on October 14', context);

    expect(result.items[0].reminder?.allDay).toBe(true);
  });

  // acceptance: timed-recurring-keeps-time - a named time means no allDay at all (absent, not false)
  it('leaves allDay absent for a recurrence with a stated time', async () => {
    replyWithReminder(0.95, {
      title: 'stretch',
      hasTimeOfDay: true,
      recurrence: { freq: 'daily', atLocal: '15:00', evidence: 'every day' },
    });

    const result = await classifier.classify('Remind me every day at 15:00 to stretch', context);

    expect(result.items[0].reminder?.recurrence).toBeDefined();
    expect(result.items[0].reminder).not.toHaveProperty('allDay');
  });

  // Invent-nothing: an absent hasTimeOfDay is not a "no".
  it('leaves allDay absent when hasTimeOfDay is missing', async () => {
    replyWithReminder(0.95, {
      title: "Bob's birthday",
      recurrence: { freq: 'yearly', month: 10, day: 14, evidence: 'birthday on October 14' },
    });

    const result = await classifier.classify('Bob has a birthday on October 14', context);

    expect(result.items[0].reminder?.recurrence).toBeDefined();
    expect(result.items[0].reminder).not.toHaveProperty('allDay');
  });

  it('never sets allDay on a one-off, even with hasTimeOfDay === false', async () => {
    replyWithReminder(0.95, {
      title: 'call the doctor',
      eventAt: '2026-09-17T09:00:00+03:00',
      hasTimeOfDay: false,
    });

    const result = await classifier.classify('remind me on Thursday to call the doctor', context);

    expect(result.items[0].reminder).not.toHaveProperty('allDay');
  });

  it('never sets allDay when the recurrence was rejected', async () => {
    replyWithReminder(0.95, {
      title: 'something weekly',
      hasTimeOfDay: false,
      recurrence: { freq: 'weekly' },
    });

    const result = await classifier.classify('remind me weekly', context);

    expect(result.items[0].reminder?.recurrence).toBeUndefined();
    expect(result.items[0].reminder).not.toHaveProperty('allDay');
  });
});

// BUG-0006: a clock time with no day ("о пів на восьму", "о 5") is resolved by code to its next
// occurrence strictly after now, instead of being dropped to clarify or left to the model's
// today/tomorrow arithmetic.
describe('ClassifierService time without a date (BUG-0006)', () => {
  const kyivMorning: ClassifierContext = { timezone: 'Europe/Kyiv', now: '2026-11-25T06:10:00+02:00' };
  let classifier: ClassifierService;

  beforeEach(() => {
    mockGenerateContent.mockReset();
    classifier = makeClassifier();
  });

  // acceptance: unit-regression / repro-fixed - no eventAt from the model, time still ahead today
  it('resolves a time-only reminder still ahead today to today, keeping confidence', async () => {
    replyWithReminder(0.95, {
      title: 'вигуляти собаку',
      hasTimeOfDay: true,
      dateStated: false,
      atLocal: '07:30',
    });

    const result = await classifier.classify('Нагадай мені о пів на восьму вигуляти собаку', kyivMorning);

    expect(result.items[0].reminder?.eventAt).toBe('2026-11-25T07:30:00+02:00');
    expect(result.items[0].confidence).toBe(0.95);
  });

  // acceptance: unit-regression / passed-time-rolls-over - a time already passed today is tomorrow
  it('resolves a time-only reminder already passed today to tomorrow', async () => {
    replyWithReminder(0.95, {
      title: 'випити вітаміни',
      hasTimeOfDay: true,
      dateStated: false,
      atLocal: '06:00',
    });

    const result = await classifier.classify('Нагадай мені о 6 ранку випити вітаміни', kyivMorning);

    expect(result.items[0].reminder?.eventAt).toBe('2026-11-26T06:00:00+02:00');
    expect(result.items[0].confidence).toBe(0.95);
  });

  // acceptance: today-not-tomorrow - code overrides a wrong date the model computed itself
  it("overrides the model's own eventAt when no date was stated", async () => {
    replyWithReminder(0.95, {
      title: 'взяти документи на роботу',
      eventAt: '2026-11-26T09:00:00+02:00',
      hasTimeOfDay: true,
      dateStated: false,
      atLocal: '09:00',
    });

    const result = await classifier.classify('Нагадай о дев’ятій ранку взяти документи на роботу', kyivMorning);

    expect(result.items[0].reminder?.eventAt).toBe('2026-11-25T09:00:00+02:00');
    expect(result.items[0].confidence).toBe(0.95);
  });

  // No regression: a stated day keeps the model's eventAt (dated-unchanged).
  it("keeps the model's eventAt when the date was stated", async () => {
    replyWithReminder(0.95, {
      title: 'вечеря',
      eventAt: '2026-11-27T20:00:00+02:00',
      hasTimeOfDay: true,
      dateStated: true,
      atLocal: '20:00',
    });

    const result = await classifier.classify('Нагадай в п’ятницю о 8 вечора про вечерю', kyivMorning);

    expect(result.items[0].reminder?.eventAt).toBe('2026-11-27T20:00:00+02:00');
    expect(result.items[0].confidence).toBe(0.95);
  });

  // No regression: without atLocal nothing is computed; the existing eventAt rules apply.
  it('keeps the existing behaviour when atLocal is absent', async () => {
    replyWithReminder(0.95, { title: 'вигуляти собаку', hasTimeOfDay: true, dateStated: false });

    const result = await classifier.classify('Нагадай вигуляти собаку', kyivMorning);

    expect(result.items[0].reminder?.eventAt).toBeUndefined();
    expect(result.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
  });

  // Invent-nothing: an absent dateStated is not a "no", and hasTimeOfDay stays the gate.
  it('does not override when dateStated is absent or hasTimeOfDay is not true', async () => {
    replyWithReminder(0.95, { title: 'a', hasTimeOfDay: true, atLocal: '07:30' });
    replyWithReminder(0.95, { title: 'b', hasTimeOfDay: false, dateStated: false, atLocal: '07:30' });

    const absent = await classifier.classify('a', kyivMorning);
    const noTime = await classifier.classify('b', kyivMorning);

    expect(absent.items[0].reminder?.eventAt).toBeUndefined();
    expect(absent.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
    expect(noTime.items[0].reminder?.eventAt).toBeUndefined();
    expect(noTime.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
  });

  // No regression: a recurring reminder is untouched by the override.
  it('leaves a recurring reminder untouched', async () => {
    replyWithReminder(0.95, {
      title: 'stretch',
      hasTimeOfDay: true,
      dateStated: false,
      atLocal: '07:30',
      recurrence: { freq: 'daily', atLocal: '07:30', evidence: 'every day' },
    });

    const result = await classifier.classify('Remind me every day at 7:30 to stretch', kyivMorning);

    expect(result.items[0].reminder?.eventAt).toBeUndefined();
    expect(result.items[0].reminder?.recurrence).toEqual({
      freq: 'daily',
      atLocal: '07:30',
      timezone: 'Europe/Kyiv',
    });
    expect(result.items[0].confidence).toBe(0.95);
  });
});

// BUG-0007: a day with no clock time ("в суботу вранці") plus explicit nudge times is actionable -
// stored all-day on that date with exactly the requested nudges - and a bare hour with no
// half-of-day word ("о 8") is whichever of H:00 and (H+12):00 comes first.
describe('ClassifierService day without a time, with nudges (BUG-0007)', () => {
  const kyivAfternoon: ClassifierContext = {
    timezone: 'Europe/Kyiv',
    now: '2026-11-25T16:18:00+02:00',
  };
  let classifier: ClassifierService;

  beforeEach(() => {
    mockGenerateContent.mockReset();
    classifier = makeClassifier();
  });

  // acceptance: unit-regression (a) / repro-fixed - the exact reply the real model gave
  it('keeps confidence and stores all-day when a day and explicit nudges were named', async () => {
    replyWithReminder(0.95, {
      title: 'здати аналізи',
      hasTimeOfDay: false,
      dateStated: true,
      eventDate: '2026-11-28',
      notifyAt: ['evening_before', '2026-11-28T06:00:00+02:00'],
    });

    const result = await classifier.classify(
      "В суботу вранці я йду здавати аналізи. Поставив мені нагадування ремайндер на п'ятницю вечір та на суботу 6 ранку.",
      kyivAfternoon,
    );

    expect(result.items[0].confidence).toBe(0.95);
    expect(result.items[0].confidence).toBeGreaterThanOrEqual(CONFIDENCE_ASK);
    expect(result.items[0].reminder?.allDay).toBe(true);
    expect(result.items[0].reminder?.eventAt).toBe('2026-11-28T23:59:00+02:00');
    expect(result.items[0].reminder?.notifyAt).toEqual([
      'evening_before',
      '2026-11-28T06:00:00+02:00',
    ]);
    expect(result.items[0].reminder?.recurrence).toBeUndefined();
  });

  // acceptance: unit-regression (b) / no-time-no-nudge-still-asks - invent-nothing
  it('stays below CONFIDENCE_ASK for a day with no time and no nudge', async () => {
    replyWithReminder(0.95, {
      title: 'здати аналізи',
      hasTimeOfDay: false,
      dateStated: true,
      eventDate: '2026-11-28',
    });

    const result = await classifier.classify('В суботу я йду здавати аналізи', kyivAfternoon);

    expect(result.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
    expect(result.items[0].reminder).not.toHaveProperty('allDay');
  });

  // at_event is not a usable nudge for an event with no time, and a nudge already past is none.
  it('stays below CONFIDENCE_ASK when the only nudges are at_event or already past', async () => {
    replyWithReminder(0.95, {
      title: 'a',
      hasTimeOfDay: false,
      eventDate: '2026-11-28',
      notifyAt: ['at_event'],
    });
    replyWithReminder(0.95, {
      title: 'b',
      hasTimeOfDay: false,
      eventDate: '2026-11-28',
      notifyAt: ['2026-11-25T09:00:00+02:00'],
    });

    const atEvent = await classifier.classify('a', kyivAfternoon);
    const past = await classifier.classify('b', kyivAfternoon);

    expect(atEvent.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
    expect(atEvent.items[0].reminder).not.toHaveProperty('allDay');
    expect(past.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
    expect(past.items[0].reminder).not.toHaveProperty('allDay');
  });

  // Only the resolvable nudges are kept; an unusable one is dropped, not repaired.
  it('keeps only the nudges that resolve to a future instant', async () => {
    replyWithReminder(0.95, {
      title: 'стоматолог',
      hasTimeOfDay: false,
      eventDate: '2026-11-27',
      notifyAt: ['evening_before', 'at_event', 'whenever'],
    });

    const result = await classifier.classify('У п’ятницю стоматолог, нагадай ввечері напередодні', kyivAfternoon);

    expect(result.items[0].confidence).toBe(0.95);
    expect(result.items[0].reminder?.allDay).toBe(true);
    expect(result.items[0].reminder?.eventAt).toBe('2026-11-27T23:59:00+02:00');
    expect(result.items[0].reminder?.notifyAt).toEqual(['evening_before']);
  });

  // A malformed or past eventDate is no all-day event.
  it('ignores a malformed or past eventDate', async () => {
    replyWithReminder(0.95, {
      title: 'a',
      hasTimeOfDay: false,
      eventDate: '28.11.2026',
      notifyAt: ['2026-11-26T09:00:00+02:00'],
    });
    replyWithReminder(0.95, {
      title: 'b',
      hasTimeOfDay: false,
      eventDate: '2026-11-24',
      notifyAt: ['2026-11-26T09:00:00+02:00'],
    });

    const malformed = await classifier.classify('a', kyivAfternoon);
    const past = await classifier.classify('b', kyivAfternoon);

    expect(malformed.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
    expect(malformed.items[0].reminder).not.toHaveProperty('allDay');
    expect(past.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
    expect(past.items[0].reminder).not.toHaveProperty('allDay');
  });

  // A stated clock time wins: eventDate is only for a day with no time.
  it('does not make a timed reminder all-day', async () => {
    replyWithReminder(0.95, {
      title: 'вечеря',
      eventAt: '2026-11-27T20:00:00+02:00',
      hasTimeOfDay: true,
      dateStated: true,
      eventDate: '2026-11-27',
      notifyAt: ['evening_before'],
    });

    const result = await classifier.classify('Вечеря в п’ятницю о 20:00', kyivAfternoon);

    expect(result.items[0].reminder?.eventAt).toBe('2026-11-27T20:00:00+02:00');
    expect(result.items[0].reminder).not.toHaveProperty('allDay');
    expect(result.items[0].confidence).toBe(0.95);
  });

  // Recurring reminders are unchanged: eventDate takes no part in them.
  it('leaves a recurring reminder untouched by eventDate', async () => {
    replyWithReminder(0.95, {
      title: "Bob's birthday",
      hasTimeOfDay: false,
      eventDate: '2026-12-14',
      notifyAt: ['evening_before'],
      recurrence: { freq: 'yearly', month: 12, day: 14, evidence: 'birthday on December 14' },
    });

    const result = await classifier.classify('Bob has a birthday on December 14', kyivAfternoon);

    expect(result.items[0].reminder?.eventAt).toBeUndefined();
    expect(result.items[0].reminder?.allDay).toBe(true);
    expect(result.items[0].confidence).toBe(0.95);
  });

  // acceptance: unit-regression (c) / bare-hour-nearest - "о 8" at 16:18 is today 20:00
  it('resolves a bare hour with no half-of-day word to the nearest of H:00 and (H+12):00', async () => {
    replyWithReminder(0.95, {
      title: 'подзвонити Сергію',
      hasTimeOfDay: true,
      dateStated: false,
      meridiemStated: false,
      atLocal: '08:00',
    });

    const result = await classifier.classify('Нагадай мені о 8 подзвонити Сергію', kyivAfternoon);

    expect(result.items[0].reminder?.eventAt).toBe('2026-11-25T20:00:00+02:00');
    expect(result.items[0].confidence).toBe(0.95);
  });

  // acceptance: meridiem-respected - "о 8 ранку" is tomorrow 08:00
  it('respects a stated half of the day', async () => {
    replyWithReminder(0.95, {
      title: 'подзвонити Сергію',
      hasTimeOfDay: true,
      dateStated: false,
      meridiemStated: true,
      atLocal: '08:00',
    });

    const result = await classifier.classify('Нагадай мені о 8 ранку подзвонити Сергію', kyivAfternoon);

    expect(result.items[0].reminder?.eventAt).toBe('2026-11-26T08:00:00+02:00');
  });

  // Invent-nothing: an absent meridiemStated is not a "no", and a morning bare hour still ahead is kept.
  it('applies the 12-hour rule only on an explicit meridiemStated false', async () => {
    replyWithReminder(0.95, { title: 'a', hasTimeOfDay: true, dateStated: false, atLocal: '08:00' });
    replyWithReminder(0.95, {
      title: 'b',
      hasTimeOfDay: true,
      dateStated: false,
      meridiemStated: false,
      atLocal: '07:30',
    });

    const absent = await classifier.classify('a', kyivAfternoon);
    const early = await classifier.classify('b', {
      timezone: 'Europe/Kyiv',
      now: '2026-11-25T06:10:00+02:00',
    });

    expect(absent.items[0].reminder?.eventAt).toBe('2026-11-26T08:00:00+02:00');
    expect(early.items[0].reminder?.eventAt).toBe('2026-11-25T07:30:00+02:00');
  });
});

describe('ClassifierService recurrence end (BUG-0008)', () => {
  let classifier: ClassifierService;
  /** The owner's message was sent on 2026-11-05 at 11:48 Kyiv; 07:00 that day had passed. */
  const asked: ClassifierContext = { timezone: 'Europe/Kyiv', now: '2026-11-05T11:48:00+02:00' };
  const later: ClassifierContext = { timezone: 'Europe/Kyiv', now: '2026-11-25T10:00:00+02:00' };

  function daily(end: Record<string, unknown>): Record<string, unknown> {
    return {
      title: 'certification',
      hasTimeOfDay: true,
      recurrence: { freq: 'daily', atLocal: '07:00', evidence: 'кожного дня', ...end },
    };
  }

  beforeEach(() => {
    mockGenerateContent.mockReset();
    classifier = makeClassifier();
  });

  // acceptance: repro-fixed - code, not the model, turns forDays into an inclusive local until,
  // counted from the first occurrence (2026-11-06 07:00): 14 days -> the 19th. forDays itself is
  // never carried on.
  it('converts forDays into until counted from the first occurrence', async () => {
    replyWithReminder(0.95, daily({ forDays: 14 }));

    const result = await classifier.classify('кожного дня о 7:00 протягом 14 днів', asked);

    expect(result.items[0].confidence).toBe(0.95);
    expect(result.items[0].reminder?.recurrence).toEqual({
      freq: 'daily',
      atLocal: '07:00',
      timezone: 'Europe/Kyiv',
      until: '2026-11-19',
    });
    expect(result.items[0].reminder?.recurrence).not.toHaveProperty('forDays');
  });

  // acceptance: until-date
  it('carries a stated until date through to the draft', async () => {
    replyWithReminder(0.95, {
      title: 'vitamins',
      hasTimeOfDay: true,
      recurrence: { freq: 'daily', atLocal: '21:00', until: '2026-12-01', evidence: 'Щодня' },
    });

    const result = await classifier.classify('Щодня о 9 вечора до 1 грудня нагадуй мені пити вітаміни', later);

    expect(result.items[0].confidence).toBe(0.95);
    expect(result.items[0].reminder?.recurrence).toEqual({
      freq: 'daily',
      atLocal: '21:00',
      timezone: 'Europe/Kyiv',
      until: '2026-12-01',
    });
  });

  // acceptance: no-end-unchanged - absent stays absent, never a placeholder end
  it('leaves until absent when the model stated no end', async () => {
    replyWithReminder(0.95, daily({}));

    const result = await classifier.classify('кожного дня о 7:00', asked);

    expect(result.items[0].confidence).toBe(0.95);
    expect(result.items[0].reminder?.recurrence).not.toHaveProperty('until');
  });

  // A stated end that cannot be kept must not silently become "forever": the bot asks instead.
  it('forces confidence below CONFIDENCE_ASK for an unusable forDays or until', async () => {
    const bad = [
      { forDays: 0 },
      { forDays: -2 },
      { forDays: 1.5 },
      { forDays: 'two weeks' },
      { until: '1 грудня' },
      { until: '2026-13-01' },
    ];
    for (const end of bad) {
      replyWithReminder(0.95, daily(end));

      const result = await classifier.classify('кожного дня о 7:00 протягом двох тижнів', asked);

      expect(result.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
      expect(result.items[0].reminder?.recurrence).not.toHaveProperty('until');
      expect(result.items[0].reminder?.recurrence).not.toHaveProperty('forDays');
    }
  });

  it('forces confidence below CONFIDENCE_ASK when until is before the first occurrence', async () => {
    replyWithReminder(0.95, daily({ until: '2026-11-05' }));

    const result = await classifier.classify('кожного дня о 7:00 до 5 листопада', asked);

    expect(result.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
  });

  it('forces confidence below CONFIDENCE_ASK when both forDays and until were given', async () => {
    replyWithReminder(0.95, daily({ forDays: 14, until: '2026-11-30' }));

    const result = await classifier.classify('кожного дня о 7:00 протягом 14 днів', asked);

    expect(result.items[0].confidence).toBeLessThan(CONFIDENCE_ASK);
  });

  // acceptance: birthday-unchanged
  it('leaves a birthday with no end unchanged', async () => {
    replyWithReminder(0.95, {
      title: "Олена's birthday",
      hasTimeOfDay: false,
      recurrence: { freq: 'yearly', month: 6, day: 12, evidence: 'день народження' },
    });

    const result = await classifier.classify('У Олени день народження 12 червня', later);

    expect(result.items[0].confidence).toBe(0.95);
    expect(result.items[0].reminder?.recurrence).not.toHaveProperty('until');
  });
});
