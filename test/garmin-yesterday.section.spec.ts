import { describe, expect, it } from 'vitest';
import { DIGEST_EMPTY_DAY_LINE, DigestService } from '../src/digest/digest.service';
import { DigestContext, DigestSection } from '../src/digest/digest.types';
import { localDay } from '../src/digest/local-day';
import {
  GarminDigestReader,
  GarminMorning,
  GarminYesterday,
  garminDates,
} from '../src/garmin/garmin-digest.reader';
import { GarminRecoverySection } from '../src/garmin/garmin-recovery.section';
import { GarminYesterdaySection } from '../src/garmin/garmin-yesterday.section';
import { fakeGarminDb } from './fake-garmin-db';

const USER = 900000004;
const ZONE = 'Europe/Kyiv';

function ctxAt(now: string): DigestContext {
  const day = localDay(new Date(now), ZONE);
  return { userId: USER, now: new Date(now), timezone: ZONE, dayStart: day.dayStart, dayEnd: day.dayEnd };
}

const CTX = ctxAt('2026-11-02T07:05:00+02:00');

/** A reader stand-in: fixed answers, no Firestore. */
function fakeReader(opts: {
  fresh?: boolean | undefined;
  yesterday?: Partial<GarminYesterday>;
  morning?: GarminMorning | null;
}) {
  return {
    isFresh: async () => ('fresh' in opts ? opts.fresh : true),
    readYesterday: async (): Promise<GarminYesterday> => ({
      date: '2026-11-01',
      day: null,
      activities: [],
      ...opts.yesterday,
    }),
    readMorning: async () => opts.morning ?? null,
  } as unknown as GarminDigestReader;
}

const section = (reader: GarminDigestReader, registry: DigestSection[] = []) =>
  new GarminYesterdaySection(reader, registry);

describe('GarminYesterdaySection', () => {
  it('registers itself once, above the calendar and reminders', () => {
    const registry: DigestSection[] = [];
    const s = section(fakeReader({}), registry);
    s.onModuleInit();
    s.onModuleInit();
    expect(registry).toEqual([s]);
    expect(s.id).toBe('garmin-yesterday');
    expect(s.order).toBe(10);
  });

  it('shows steps against the goal, floors and workouts in time order', async () => {
    const result = await section(
      fakeReader({
        yesterday: {
          day: { steps: 8200, stepsGoal: 10000, floorsUp: 25 },
          activities: [
            { type: 'running', startTimeLocal: '2026-11-01 07:30:00', durationSec: 45 * 60 },
            { type: 'strength_training', startTimeLocal: '2026-11-01 18:00:00', durationSec: 30 * 60 + 12 },
          ],
        },
      }),
    ).build(CTX);

    expect(result).toEqual({
      title: '🏃 Вчора, 1 листопада',
      lines: [
        'Кроки: 8 200 з 10 000  🟩🟩🟩🟩🟩🟩🟩🟩⬜⬜',
        'Поверхи: 25',
        'Тренування: Біг 45 хв, Силова 30 хв',
      ],
    });
  });

  it('shows the real number and a full bar when the goal is beaten', async () => {
    const result = await section(
      fakeReader({ yesterday: { day: { steps: 14250, stepsGoal: 10000, floorsUp: null } } }),
    ).build(CTX);
    expect(result?.lines[0]).toBe(`Кроки: 14 250 з 10 000  ${'🟩'.repeat(10)}`);
  });

  it('without a goal shows only the steps, no bar', async () => {
    const result = await section(
      fakeReader({ yesterday: { day: { steps: 8200, stepsGoal: null, floorsUp: null } } }),
    ).build(CTX);
    expect(result?.lines[0]).toBe('Кроки: 8 200');
  });

  it('shows 0 floors but no line for null floors or null steps', async () => {
    const zero = await section(
      fakeReader({ yesterday: { day: { steps: null, stepsGoal: 10000, floorsUp: 0 } } }),
    ).build(CTX);
    expect(zero?.lines).toEqual(['Поверхи: 0', 'Тренування: вихідний']);
  });

  it('a synced day with no activities is a rest day', async () => {
    const result = await section(
      fakeReader({ yesterday: { day: { steps: 3000, stepsGoal: 10000, floorsUp: 2 }, activities: [] } }),
    ).build(CTX);
    expect(result?.lines).toContain('Тренування: вихідний');
  });

  it('with no document for yesterday there is no rest-day line (unknown, not nothing)', async () => {
    const result = await section(fakeReader({ yesterday: { day: null, activities: [] } })).build(CTX);
    expect(result).toBeNull();
  });

  it('still lists known activities when the day document is missing', async () => {
    const result = await section(
      fakeReader({
        yesterday: {
          day: null,
          activities: [{ type: 'pickleball', startTimeLocal: '2026-11-01 10:00:00', durationSec: null }],
        },
      }),
    ).build(CTX);
    expect(result?.lines).toEqual(['Тренування: Тренування']);
  });

  it('never shows a raw Garmin key', async () => {
    const result = await section(
      fakeReader({
        yesterday: {
          day: { steps: null, stepsGoal: null, floorsUp: null },
          activities: [{ type: 'lap_swimming', startTimeLocal: '2026-11-01 10:00:00', durationSec: 1800 }],
        },
      }),
    ).build(CTX);
    expect(JSON.stringify(result)).not.toMatch(/lap_swimming|2026-11-01/);
  });

  it('no Garmin (no garminSync doc): nothing at all', async () => {
    const result = await section(
      fakeReader({ fresh: undefined, yesterday: { day: { steps: 1, stepsGoal: 1, floorsUp: 1 } } }),
    ).build(CTX);
    expect(result).toBeNull();
  });

  it('stale sync: the single "⌚ Garmin" card instead of data', async () => {
    const result = await section(
      fakeReader({ fresh: false, yesterday: { day: { steps: 8200, stepsGoal: 10000, floorsUp: 3 } } }),
    ).build(CTX);
    expect(result).toEqual({ title: '⌚ Garmin', lines: ['сьогодні даних немає'] });
  });
});

describe('Garmin sections over a fake Firestore', () => {
  const base = `users/${USER}`;

  function digestOver(seed: Record<string, Record<string, unknown>>) {
    const fake = fakeGarminDb(seed);
    const reader = new GarminDigestReader({ db: fake.db, available: true } as never);
    const registry: DigestSection[] = [];
    new GarminYesterdaySection(reader, registry).onModuleInit();
    new GarminRecoverySection(reader, registry).onModuleInit();
    return { digest: new DigestService(registry), fake, registry };
  }

  const fresh = (iso: string) => ({ [`${base}/system/garminSync`]: { lastSuccessAt: iso } });

  it('reads two different dates: sleep from today, steps and workouts from yesterday', async () => {
    const { digest, fake } = digestOver({
      ...fresh('2026-11-02T05:01:00.000Z'),
      [`${base}/health_daily/2026-11-01`]: {
        movement: { steps: 8200, stepsGoal: 10000, floorsUp: 25 },
        sleep: { seconds: 1, score: 1 },
      },
      [`${base}/health_daily/2026-11-02`]: {
        movement: { steps: 120, stepsGoal: 10000, floorsUp: 0 },
        sleep: { seconds: 7 * 3600 + 20 * 60, score: 82, scoreQualifier: 'GOOD' },
        hrv: { lastNightAvg: 62, baselineBalancedLow: 55, baselineBalancedUpper: 70 },
        heart: { resting: 52 },
      },
      [`${base}/activities/1`]: { type: 'running', startTimeLocal: '2026-11-01 07:30:00', durationSec: 2700 },
      [`${base}/activities/2`]: { type: 'running', startTimeLocal: '2026-11-02 06:00:00', durationSec: 600 },
      [`${base}/activities/3`]: { type: 'yoga', startTimeLocal: '2026-10-31 23:59:59', durationSec: 600 },
    });

    const text = await digest.build(CTX);
    expect(text).toBe(
      [
        'Доброго ранку! Сьогодні 2 листопада.',
        [
          '🏃 Вчора, 1 листопада',
          '• Кроки: 8 200 з 10 000  🟩🟩🟩🟩🟩🟩🟩🟩⬜⬜',
          '• Поверхи: 25',
          '• Тренування: Біг 45 хв',
        ].join('\n'),
        [
          '😴 Сон і відновлення',
          '• Сон: 7 год 20 хв, оцінка 82 (добре)',
          '• HRV: 62 мс, у діапазоні 55-70  🟢  55 ░░░░●░░░░░ 70',
          '• Пульс спокою: 52',
        ].join('\n'),
      ].join('\n\n'),
    );

    // One single-field range on startTimeLocal - no composite index.
    const activityQueries = fake.queries.filter((q) => q.path.endsWith('/activities'));
    expect(activityQueries).toEqual([
      {
        path: `${base}/activities`,
        filters: [
          { field: 'startTimeLocal', op: '>=', value: '2026-11-01' },
          { field: 'startTimeLocal', op: '<', value: '2026-11-02' },
        ],
      },
    ]);
  });

  it('DST spring-forward: yesterday is the calendar day before, not 24 hours back', async () => {
    // Kyiv moved to summer time on 2026-03-29; local midnight of the 30th minus 24 h is still the 28th.
    const ctx = ctxAt('2026-03-30T07:00:00+03:00');
    expect(garminDates(ctx)).toEqual({ today: '2026-03-30', yesterday: '2026-03-29' });

    const { digest } = digestOver({
      ...fresh('2026-03-30T04:00:00.000Z'),
      [`${base}/health_daily/2026-03-28`]: { movement: { steps: 1111, stepsGoal: null, floorsUp: null } },
      [`${base}/health_daily/2026-03-29`]: { movement: { steps: 2222, stepsGoal: null, floorsUp: null } },
    });
    const text = await digest.build(ctx);
    expect(text).toContain('🏃 Вчора, 29 березня\n• Кроки: 2 222\n• Тренування: вихідний');
    expect(text).not.toContain('1 111');
  });

  it('DST fall-back: the 25-hour day is still one calendar day', async () => {
    const ctx = ctxAt('2026-10-26T07:00:00+02:00');
    expect(garminDates(ctx)).toEqual({ today: '2026-10-26', yesterday: '2026-10-25' });
  });

  it('stale sync replaces both sections with one card, which counts as content', async () => {
    const { digest } = digestOver({
      // Yesterday's success, not today's.
      ...fresh('2026-11-01T05:01:00.000Z'),
      [`${base}/health_daily/2026-11-01`]: { movement: { steps: 8200, stepsGoal: 10000, floorsUp: 25 } },
      [`${base}/health_daily/2026-11-02`]: { sleep: { seconds: 25000, score: 80 }, heart: { resting: 50 } },
    });
    const text = await digest.build(CTX);
    expect(text).toBe('Доброго ранку! Сьогодні 2 листопада.\n\n⌚ Garmin\n• сьогодні даних немає');
    expect(text).not.toContain(DIGEST_EMPTY_DAY_LINE);
  });

  it('a garminSync doc with no success at all is stale', async () => {
    const { digest } = digestOver({ [`${base}/system/garminSync`]: { lastRunAt: '2026-11-02T05:00:00Z' } });
    expect(await digest.build(CTX)).toContain('⌚ Garmin\n• сьогодні даних немає');
  });

  it('freshness is the local date: 23:30 UTC the night before is already today in Kyiv', async () => {
    const { digest } = digestOver({
      ...fresh('2026-11-01T22:30:00.000Z'),
      [`${base}/health_daily/2026-11-02`]: { heart: { resting: 51 } },
    });
    expect(await digest.build(CTX)).toContain('😴 Сон і відновлення\n• Пульс спокою: 51');
  });

  it('no garminSync doc: no Garmin section, and an otherwise empty day gets the 0024 line', async () => {
    const { digest } = digestOver({
      [`${base}/health_daily/2026-11-01`]: { movement: { steps: 8200, stepsGoal: 10000, floorsUp: 25 } },
    });
    const text = await digest.build(CTX);
    expect(text).toBe(`Доброго ранку! Сьогодні 2 листопада.\n\n${DIGEST_EMPTY_DAY_LINE}`);
  });

  it('fresh but no data documents at all: both sections are silent (0024 line applies)', async () => {
    const { digest } = digestOver(fresh('2026-11-02T05:01:00.000Z'));
    expect(await digest.build(CTX)).toBe(
      `Доброго ранку! Сьогодні 2 листопада.\n\n${DIGEST_EMPTY_DAY_LINE}`,
    );
  });

  it('reads garminSync once per digest for both sections', async () => {
    const { digest, fake } = digestOver(fresh('2026-11-02T05:01:00.000Z'));
    let reads = 0;
    const original = fake.db.collection;
    fake.db.collection = ((name: string) => {
      const users = original(name);
      return {
        ...users,
        doc: (id: string) => {
          const user = users.doc(id);
          return {
            ...user,
            collection: (sub: string) => {
              const col = user.collection(sub);
              return sub === 'system'
                ? { ...col, doc: (d: string) => ((reads += d === 'garminSync' ? 1 : 0), col.doc(d)) }
                : col;
            },
          };
        },
      };
    }) as typeof fake.db.collection;
    await digest.build(CTX);
    expect(reads).toBe(1);
  });

  it('with no Firestore, the sections are silent', async () => {
    const reader = new GarminDigestReader({ db: undefined, available: false } as never);
    expect(await new GarminYesterdaySection(reader, []).build(CTX)).toBeNull();
    expect(await new GarminRecoverySection(reader, []).build(CTX)).toBeNull();
  });
});
