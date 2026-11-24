import { describe, expect, it } from 'vitest';
import { DigestContext, DigestSection } from '../src/digest/digest.types';
import { GarminDigestReader, GarminMorning } from '../src/garmin/garmin-digest.reader';
import { GarminRecoverySection } from '../src/garmin/garmin-recovery.section';

const CTX: DigestContext = {
  userId: 900000004,
  now: new Date('2026-11-02T07:05:00+02:00'),
  timezone: 'Europe/Kyiv',
  dayStart: new Date('2026-11-02T00:00:00+02:00'),
  dayEnd: new Date('2026-11-03T00:00:00+02:00'),
};

const EMPTY: GarminMorning = {
  sleepSeconds: null,
  sleepScore: null,
  sleepScoreQualifier: null,
  hrvLastNightAvg: null,
  hrvBaselineBalancedLow: null,
  hrvBaselineBalancedUpper: null,
  restingHr: null,
};

const FULL: GarminMorning = {
  sleepSeconds: 7 * 3600 + 20 * 60 + 41,
  sleepScore: 82,
  sleepScoreQualifier: 'GOOD',
  hrvLastNightAvg: 62,
  hrvBaselineBalancedLow: 55,
  hrvBaselineBalancedUpper: 70,
  restingHr: 52,
};

/** `fresh` is passed explicitly when it matters: undefined (no Garmin) is a real answer here. */
function sectionWith(morning: GarminMorning | null, ...fresh: [boolean | undefined] | []) {
  const reader = {
    isFresh: async () => (fresh.length > 0 ? fresh[0] : true),
    readMorning: async () => morning,
    readYesterday: async () => {
      throw new Error('not used');
    },
  } as unknown as GarminDigestReader;
  return new GarminRecoverySection(reader, []);
}

const lines = async (morning: Partial<GarminMorning>) =>
  (await sectionWith({ ...EMPTY, ...morning }).build(CTX))?.lines;

describe('GarminRecoverySection', () => {
  it('registers itself once, right after the yesterday section', () => {
    const registry: DigestSection[] = [];
    const s = new GarminRecoverySection({} as GarminDigestReader, registry);
    s.onModuleInit();
    s.onModuleInit();
    expect(registry).toEqual([s]);
    expect(s.id).toBe('garmin-recovery');
    expect(s.order).toBe(11);
  });

  it('shows sleep with score and qualifier, HRV in range, and resting HR', async () => {
    expect(await sectionWith(FULL).build(CTX)).toEqual({
      title: '😴 Сон і відновлення',
      lines: [
        'Сон: 7 год 20 хв, оцінка 82 (добре)',
        'HRV: 62 мс, у діапазоні 55-70  🟢  55 ░░░░●░░░░░ 70',
        'Пульс спокою: 52',
      ],
    });
  });

  it('sleep: no score - duration only; unknown qualifier - not shown', async () => {
    expect(await lines({ sleepSeconds: 6 * 3600, sleepScoreQualifier: 'GOOD' })).toEqual(['Сон: 6 год']);
    expect(await lines({ sleepSeconds: 6 * 3600, sleepScore: 70, sleepScoreQualifier: 'MYSTERY' })).toEqual([
      'Сон: 6 год, оцінка 70',
    ]);
  });

  it('sleep not synced yet: no sleep line, not "0 год"', async () => {
    const result = await lines({ ...FULL, sleepSeconds: null });
    expect(result).toEqual([
      'HRV: 62 мс, у діапазоні 55-70  🟢  55 ░░░░●░░░░░ 70',
      'Пульс спокою: 52',
    ]);
  });

  it('HRV below and above the baseline', async () => {
    expect(await lines({ hrvLastNightAvg: 48, hrvBaselineBalancedLow: 55, hrvBaselineBalancedUpper: 70 })).toEqual([
      'HRV: 48 мс, нижче діапазону 55-70  🟠  ⬇ 55 ░░░░░░░░░░ 70',
    ]);
    expect(await lines({ hrvLastNightAvg: 81, hrvBaselineBalancedLow: 55, hrvBaselineBalancedUpper: 70 })).toEqual([
      'HRV: 81 мс, вище діапазону 55-70  🟠  55 ░░░░░░░░░░ 70 ⬆',
    ]);
  });

  it('HRV without bounds, or with broken bounds: the number alone', async () => {
    expect(await lines({ hrvLastNightAvg: 62 })).toEqual(['HRV: 62 мс']);
    expect(await lines({ hrvLastNightAvg: 62, hrvBaselineBalancedLow: 70, hrvBaselineBalancedUpper: 70 })).toEqual([
      'HRV: 62 мс',
    ]);
  });

  it('resting HR present is one number, null is no line', async () => {
    expect(await lines({ restingHr: 49 })).toEqual(['Пульс спокою: 49']);
    expect(await lines({ ...FULL, restingHr: null })).not.toContainEqual(expect.stringContaining('Пульс'));
  });

  it('all null, or no document for today: the section is null', async () => {
    expect(await sectionWith(EMPTY).build(CTX)).toBeNull();
    expect(await sectionWith(null).build(CTX)).toBeNull();
  });

  it('silent when the user has no Garmin, and when the sync is stale (the yesterday section shows the card)', async () => {
    expect(await sectionWith(FULL, undefined).build(CTX)).toBeNull();
    expect(await sectionWith(FULL, false).build(CTX)).toBeNull();
  });

  it('no verdict words beyond Garmin\'s own qualifier, no raw keys', async () => {
    const text = JSON.stringify(await sectionWith({ ...FULL, sleepScoreQualifier: 'FAIR' }).build(CTX));
    expect(text).not.toMatch(/молодець|треба|GOOD|FAIR/);
  });
});
