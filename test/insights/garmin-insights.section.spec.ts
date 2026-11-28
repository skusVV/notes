import { describe, expect, it, vi } from 'vitest';
import { DIGEST_EMPTY_DAY_LINE, DigestService } from '../../src/digest/digest.service';
import { DigestContext, DigestSection } from '../../src/digest/digest.types';
import { localDay } from '../../src/digest/local-day';
import { GarminDigestReader } from '../../src/garmin/garmin-digest.reader';
import { GarminHistoryReader, HISTORY_DAYS } from '../../src/garmin/garmin-history.reader';
import {
  GARMIN_INSIGHTS_STALE_LINE,
  GARMIN_INSIGHTS_TITLE,
  GarminInsightsSection,
} from '../../src/garmin/garmin-insights.section';
import {
  GARMIN_RAW_NONE,
  GARMIN_RAW_STALE,
  GarminRawService,
  rawText,
} from '../../src/garmin/garmin-raw';
import { InsightPhrasingService } from '../../src/insights/insight-phrasing.service';
import { shiftDate } from '../../src/insights/norms';
import { PlannedLine } from '../../src/insights/rank';
import { fakeGarminDb } from '../fake-garmin-db';

const USER = 900000004;
const ZONE = 'Europe/Kyiv';
const BASE = `users/${USER}`;

function ctxAt(now: string): DigestContext {
  const day = localDay(new Date(now), ZONE);
  return { userId: USER, now: new Date(now), timezone: ZONE, dayStart: day.dayStart, dayEnd: day.dayEnd };
}

const CTX = ctxAt('2026-11-25T07:05:00+02:00');
const TODAY = '2026-11-25';
const FRESH = { [`${BASE}/system/garminSync`]: { lastSuccessAt: '2026-11-25T04:30:00.000Z' } };
const STALE = { [`${BASE}/system/garminSync`]: { lastSuccessAt: '2026-11-24T04:30:00.000Z' } };

/** Health docs: a month of steady data, and a three-day step streak ending yesterday. */
function month(today = TODAY): Record<string, Record<string, unknown>> {
  const docs: Record<string, Record<string, unknown>> = {};
  for (let back = 0; back <= 30; back += 1) {
    const date = shiftDate(today, -back);
    docs[`${BASE}/health_daily/${date}`] = {
      date,
      source: 'garmin',
      heart: { resting: 50 },
      bodyBattery: { max: 80 },
      hrv: { lastNightAvg: 60, baselineBalancedLow: 50, baselineBalancedUpper: 70 },
      movement: { steps: back >= 1 && back <= 3 ? 11000 : 9000, stepsGoal: 10000, floorsUp: 5 },
    };
  }
  return docs;
}

const templatesOnly = () => new InsightPhrasingService({ get: () => undefined } as never);

function setup(seed: Record<string, Record<string, unknown>>, phrasing: InsightPhrasingService = templatesOnly()) {
  const fake = fakeGarminDb(seed);
  const firestore = { db: fake.db } as never;
  const reader = new GarminDigestReader(firestore);
  const history = new GarminHistoryReader(firestore);
  const registry: DigestSection[] = [];
  const section = new GarminInsightsSection(reader, history, phrasing, registry);
  section.onModuleInit();
  return { fake, reader, history, section, registry, digest: new DigestService(registry) };
}

describe('GarminInsightsSection', () => {
  it('registers itself once, first in the digest', () => {
    const { section, registry } = setup({});
    section.onModuleInit();
    expect(registry).toEqual([section]);
    expect(section.id).toBe('garmin-insights');
    expect(section.order).toBe(10);
  });

  it('no garminSync: null, and nothing else is read', async () => {
    const { section, fake } = setup(month());
    expect(await section.build(CTX)).toBeNull();
    expect(fake.getAlls).toEqual([]);
    expect(fake.queries).toEqual([]);
  });

  it('no garminSync: the digest has no Garmin at all (0024 empty-day line instead)', async () => {
    const { digest } = setup({});
    const { text, keyboard } = await digest.build(CTX);
    expect(text).not.toContain('⌚');
    expect(text).not.toContain('Garmin');
    expect(text).toContain(DIGEST_EMPTY_DAY_LINE);
    expect(keyboard).toBeUndefined();
  });

  it('stale sync: one "сьогодні даних немає" line, no button, which counts as content', async () => {
    const { section, digest, fake } = setup({ ...STALE, ...month() });
    expect(await section.build(CTX)).toEqual({ title: GARMIN_INSIGHTS_TITLE, lines: [GARMIN_INSIGHTS_STALE_LINE] });
    const { text, keyboard } = await digest.build(CTX);
    expect(text).toContain(`${GARMIN_INSIGHTS_TITLE}\n• ${GARMIN_INSIGHTS_STALE_LINE}`);
    expect(text).not.toContain(DIGEST_EMPTY_DAY_LINE);
    expect(keyboard).toBeUndefined();
    expect(fake.writes).toEqual([]);
  });

  it('fresh: readiness, insights, the gd:raw button, and the journal written', async () => {
    const { section, fake } = setup({ ...FRESH, ...month() });
    const result = await section.build(CTX);

    expect(result?.title).toBe(GARMIN_INSIGHTS_TITLE);
    expect(result?.lines[0].startsWith('🟢')).toBe(true);
    expect(result?.lines).toContain('3 дні поспіль кроки вище цілі, так тримати.');
    expect(result?.keyboard).toEqual({ inline_keyboard: [[{ text: '📊 Дані Garmin', callback_data: 'gd:raw' }]] });

    expect(fake.writes).toEqual([
      { path: `${BASE}/system/digestInsights`, data: { shown: { 'streak:steps:3': TODAY } } },
    ]);
    // Read-only towards the morning job: the only write is the bot's own journal.
    expect(fake.writes.every((w) => w.path.endsWith('/system/digestInsights'))).toBe(true);
  });

  it('reads 31 days by id and activities with one single-field range', async () => {
    const { section, fake } = setup({ ...FRESH, ...month() });
    await section.build(CTX);
    expect(fake.getAlls).toHaveLength(1);
    expect(fake.getAlls[0]).toHaveLength(HISTORY_DAYS);
    expect(fake.getAlls[0][0]).toBe(`${BASE}/health_daily/2026-10-26`);
    expect(fake.getAlls[0][30]).toBe(`${BASE}/health_daily/${TODAY}`);
    const activityQueries = fake.queries.filter((q) => q.path.endsWith('/activities'));
    expect(activityQueries).toEqual([
      {
        path: `${BASE}/activities`,
        filters: [
          { field: 'startTimeLocal', op: '>=', value: '2026-10-26' },
          { field: 'startTimeLocal', op: '<', value: '2026-11-26' },
        ],
      },
    ]);
  });

  it('the journal blocks a repeat: the next day the streak line is not shown again', async () => {
    const { section, fake } = setup({
      ...FRESH,
      ...month(),
      [`${BASE}/system/digestInsights`]: { shown: { 'streak:steps:3': shiftDate(TODAY, -1), ancient: '2026-09-01' } },
    });
    const result = await section.build(CTX);
    expect(result?.lines).not.toContain('3 дні поспіль кроки вище цілі, так тримати.');
    // Whatever replaced it, the old key is pruned on the write.
    const written = fake.writes[0].data as { shown: Record<string, string> };
    expect(written.shown.ancient).toBeUndefined();
    expect(written.shown['streak:steps:3']).toBe(shiftDate(TODAY, -1));
  });

  it('DST spring-forward morning: today is the local date, the window is calendar days', async () => {
    const ctx = ctxAt('2026-03-29T07:05:00+03:00');
    const { section, fake } = setup({
      [`${BASE}/system/garminSync`]: { lastSuccessAt: '2026-03-29T04:00:00.000Z' },
      ...month('2026-03-29'),
    });
    const result = await section.build(ctx);
    expect(result).not.toBeNull();
    expect(fake.getAlls[0][30]).toBe(`${BASE}/health_daily/2026-03-29`);
    expect(fake.getAlls[0][29]).toBe(`${BASE}/health_daily/2026-03-28`);
    expect(fake.getAlls[0][0]).toBe(`${BASE}/health_daily/2026-02-27`);
  });

  it('fresh but no data documents: null, no button', async () => {
    const { section } = setup({ ...FRESH });
    expect(await section.build(CTX)).toBeNull();
  });

  it('a failed journal read is an empty journal; a failed write does not fail the section', async () => {
    const { section, history } = setup({ ...FRESH, ...month() });
    vi.spyOn(history, 'readJournal').mockRejectedValue(new Error('unavailable'));
    vi.spyOn(history, 'writeJournal').mockRejectedValue(new Error('unavailable'));
    const result = await section.build(CTX);
    expect(result?.lines).toContain('3 дні поспіль кроки вище цілі, так тримати.');
    expect(result?.keyboard).toBeDefined();
  });

  it('phrased lines replace templates; the readiness colour stays code-owned', async () => {
    const phrasing = templatesOnly();
    vi.spyOn(phrasing, 'phrase').mockImplementation(async (lines: readonly PlannedLine[]) => ({
      texts: lines.map((line) => (line.id === 'readiness' ? 'Сьогодні все гаразд, тисни.' : line.template)),
      fallback: 1,
    }));
    const { section } = setup({ ...FRESH, ...month() }, phrasing);
    const result = await section.build(CTX);
    expect(result?.lines[0]).toBe('🟢 Сьогодні все гаразд, тисни.');
  });
});

describe('Garmin raw data (gd:raw)', () => {
  const NOW = new Date('2026-11-25T09:00:00+02:00');
  const rich = {
    [`${BASE}/health_daily/${TODAY}`]: {
      sleep: { seconds: 7 * 3600 + 20 * 60, needMinutes: 480, score: 82, scoreQualifier: 'GOOD' },
      hrv: { lastNightAvg: 62, baselineBalancedLow: 55, baselineBalancedUpper: 70 },
      heart: { resting: 51 },
    },
    [`${BASE}/health_daily/2026-11-24`]: {
      movement: { steps: 8200, stepsGoal: 10000, floorsUp: 12 },
      calories: { total: 2450, active: 620 },
    },
  };
  const service = (seed: Record<string, Record<string, unknown>>) => {
    const fake = fakeGarminDb(seed);
    return new GarminRawService(new GarminDigestReader({ db: fake.db } as never));
  };

  it('no garminSync: "Даних Garmin немає."', async () => {
    expect(await service(rich).text(USER, NOW, ZONE)).toBe(GARMIN_RAW_NONE);
  });

  it('stale sync: "Сьогодні даних Garmin ще немає."', async () => {
    expect(await service({ ...STALE, ...rich }).text(USER, NOW, ZONE)).toBe(GARMIN_RAW_STALE);
  });

  it('fresh: sleep, HRV, resting HR and yesterday, read at tap time', async () => {
    const text = await service({ ...FRESH, ...rich }).text(USER, NOW, ZONE);
    const lines = text.split('\n');
    expect(lines[0]).toBe('📊 Дані Garmin, 25 листопада');
    expect(lines[1]).toBe('Сон: 7 год 20 хв, потреба 8 год, оцінка 82 (добре)');
    expect(lines[2]).toMatch(/^HRV: 62 мс, у діапазоні 55-70/);
    expect(lines[3]).toBe('Пульс спокою: 51');
    expect(lines[4]).toMatch(/^Кроки вчора: 8 200 з 10 000 {2}🟩/);
    expect(lines[5]).toBe('Поверхи вчора: 12');
    expect(lines[6]).toBe('Калорії вчора: усього 2 450, активні 620');
    expect(text).not.toContain('GOOD');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('a missing field is no line, never 0; nothing at all is the "not yet" text', () => {
    const text = rawText(TODAY, null, {
      date: '2026-11-24',
      day: { steps: 5000, stepsGoal: null, floorsUp: null, caloriesTotal: null, caloriesActive: null },
      activities: [],
    });
    expect(text.split('\n')).toEqual(['📊 Дані Garmin, 25 листопада', 'Кроки вчора: 5 000']);
    expect(rawText(TODAY, null, null)).toBe(GARMIN_RAW_STALE);
  });
});
