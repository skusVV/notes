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
