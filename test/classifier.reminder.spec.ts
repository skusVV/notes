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
