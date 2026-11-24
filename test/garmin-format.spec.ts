import { describe, expect, it } from 'vitest';
import {
  activityLabel,
  formatDuration,
  formatSteps,
  hrvRangeBar,
  progressBar,
  sleepQualifierLabel,
} from '../src/garmin/garmin-format';

describe('progressBar', () => {
  it('is exactly 10 cells, round(value / goal * 10) of them green', () => {
    expect(progressBar(8200, 10000)).toBe('🟩🟩🟩🟩🟩🟩🟩🟩⬜⬜');
    expect(progressBar(8500, 10000)).toBe('🟩🟩🟩🟩🟩🟩🟩🟩🟩⬜');
    expect(progressBar(0, 10000)).toBe('⬜'.repeat(10));
    expect([...progressBar(3000, 7000)!]).toHaveLength(10);
  });

  it('caps at 10 green when the goal is beaten', () => {
    expect(progressBar(25000, 10000)).toBe('🟩'.repeat(10));
  });

  it('has no bar without a usable goal', () => {
    expect(progressBar(8200, null)).toBeNull();
    expect(progressBar(8200, undefined)).toBeNull();
    expect(progressBar(8200, 0)).toBeNull();
    expect(progressBar(8200, -5)).toBeNull();
  });
});

describe('hrvRangeBar', () => {
  it('in range: green, marker at round((v - low) / (upper - low) * 9), bounds on both sides', () => {
    // (62 - 55) / 15 * 9 = 4.2 -> cell 4
    expect(hrvRangeBar(62, 55, 70)).toBe('у діапазоні 55-70  🟢  55 ░░░░●░░░░░ 70');
    expect(hrvRangeBar(55, 55, 70)).toBe('у діапазоні 55-70  🟢  55 ●░░░░░░░░░ 70');
    expect(hrvRangeBar(70, 55, 70)).toBe('у діапазоні 55-70  🟢  55 ░░░░░░░░░● 70');
  });

  it('below: orange, the text, a bar without a marker and a down arrow', () => {
    const out = hrvRangeBar(48, 55, 70);
    expect(out).toBe('нижче діапазону 55-70  🟠  ⬇ 55 ░░░░░░░░░░ 70');
    expect(out).not.toContain('●');
  });

  it('above: orange, the text and an up arrow', () => {
    const out = hrvRangeBar(80, 55, 70);
    expect(out).toBe('вище діапазону 55-70  🟠  55 ░░░░░░░░░░ 70 ⬆');
    expect(out).not.toContain('●');
  });

  it('broken or missing bounds give nothing, and never divide by zero', () => {
    expect(hrvRangeBar(60, 60, 60)).toBeNull();
    expect(hrvRangeBar(60, 70, 55)).toBeNull();
    expect(hrvRangeBar(60, null, 70)).toBeNull();
    expect(hrvRangeBar(60, 55, null)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('drops seconds and writes hours and minutes', () => {
    expect(formatDuration(45 * 60)).toBe('45 хв');
    expect(formatDuration(45 * 60 + 59)).toBe('45 хв');
    expect(formatDuration(3600 + 5 * 60)).toBe('1 год 5 хв');
    expect(formatDuration(2 * 3600)).toBe('2 год');
    expect(formatDuration(7 * 3600 + 20 * 60 + 30)).toBe('7 год 20 хв');
  });

  it('is <1 хв under a minute', () => {
    expect(formatDuration(0)).toBe('<1 хв');
    expect(formatDuration(59)).toBe('<1 хв');
    expect(formatDuration(60)).toBe('1 хв');
  });
});

describe('activityLabel', () => {
  it('maps the known Garmin types', () => {
    expect(activityLabel('running')).toBe('Біг');
    expect(activityLabel('walking')).toBe('Ходьба');
    expect(activityLabel('cycling')).toBe('Велосипед');
    expect(activityLabel('strength_training')).toBe('Силова');
    expect(activityLabel('hiking')).toBe('Похід');
    expect(activityLabel('swimming')).toBe('Плавання');
    expect(activityLabel('yoga')).toBe('Йога');
    expect(activityLabel('breathwork')).toBe('Дихання');
  });

  it('maps the variants found in real data', () => {
    expect(activityLabel('lap_swimming')).toBe('Плавання');
    expect(activityLabel('open_water_swimming')).toBe('Плавання');
    expect(activityLabel('road_biking')).toBe('Велосипед');
    expect(activityLabel('indoor_cycling')).toBe('Велосипед');
    expect(activityLabel('virtual_ride')).toBe('Велосипед');
    expect(activityLabel('treadmill_running')).toBe('Біг');
    expect(activityLabel('kayaking_v2')).toBe('Каяк');
    expect(activityLabel('other')).toBe('Тренування');
  });

  it('never shows a raw key: unknown or missing is Тренування', () => {
    expect(activityLabel('pickleball')).toBe('Тренування');
    expect(activityLabel(null)).toBe('Тренування');
    expect(activityLabel(undefined)).toBe('Тренування');
  });
});

describe('sleepQualifierLabel', () => {
  it("translates Garmin's own qualifier, case-insensitively", () => {
    expect(sleepQualifierLabel('EXCELLENT')).toBe('відмінно');
    expect(sleepQualifierLabel('GOOD')).toBe('добре');
    expect(sleepQualifierLabel('good')).toBe('добре');
    expect(sleepQualifierLabel('Fair')).toBe('посередньо');
    expect(sleepQualifierLabel('POOR')).toBe('погано');
  });

  it('hides anything else instead of showing raw English', () => {
    expect(sleepQualifierLabel('INVALID')).toBeNull();
    expect(sleepQualifierLabel('')).toBeNull();
    expect(sleepQualifierLabel(null)).toBeNull();
  });
});

describe('formatSteps', () => {
  it('separates thousands with a space', () => {
    expect(formatSteps(8200)).toBe('8 200');
    expect(formatSteps(10000)).toBe('10 000');
    expect(formatSteps(1234567)).toBe('1 234 567');
    expect(formatSteps(950)).toBe('950');
    expect(formatSteps(0)).toBe('0');
  });
});
