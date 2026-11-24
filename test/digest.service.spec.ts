import { describe, expect, it } from 'vitest';
import {
  DIGEST_EMPTY_DAY_LINE,
  DIGEST_MAX_LINES_PER_SECTION,
  DigestService,
} from '../src/digest/digest.service';
import { DigestContext, DigestSection, DigestSectionResult } from '../src/digest/digest.types';

const CTX: DigestContext = {
  userId: 900000003,
  now: new Date('2026-09-16T07:00:00+03:00'),
  timezone: 'Europe/Kyiv',
  dayStart: new Date('2026-09-16T00:00:00+03:00'),
  dayEnd: new Date('2026-09-17T00:00:00+03:00'),
};

function section(
  id: string,
  order: number,
  result: DigestSectionResult | null | (() => Promise<DigestSectionResult | null>),
): DigestSection {
  return {
    id,
    order,
    build: typeof result === 'function' ? result : async () => result,
  };
}

describe('DigestService.build', () => {
  it('composes the greeting, the heading and bulleted lines as plain text', async () => {
    const service = new DigestService([
      section('reminders', 100, {
        title: 'Нагадування',
        lines: ['Прийняти таблетки - о 14:00', 'Лікар - о 17:30'],
      }),
    ]);

    expect(await service.build(CTX)).toBe(
      [
        'Доброго ранку! Сьогодні 16 вересня.',
        '',
        'Нагадування',
        '• Прийняти таблетки - о 14:00',
        '• Лікар - о 17:30',
      ].join('\n'),
    );
  });

  it('never puts a raw ISO timestamp in the message', async () => {
    const service = new DigestService([section('a', 1, { title: 'A', lines: ['x'] })]);
    const text = await service.build(CTX);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('orders sections by `order`, not by registration order', async () => {
    const service = new DigestService([
      section('late', 300, { title: 'Третій', lines: ['c'] }),
      section('early', 50, { title: 'Перший', lines: ['a'] }),
      section('middle', 100, { title: 'Другий', lines: ['b'] }),
    ]);

    const text = (await service.build(CTX)) ?? '';
    const first = text.indexOf('Перший');
    const second = text.indexOf('Другий');
    const third = text.indexOf('Третій');
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
  });

  it('a section that throws does not block the others', async () => {
    const service = new DigestService([
      section('broken', 10, async () => {
        throw new Error('boom');
      }),
      section('reminders', 100, { title: 'Нагадування', lines: ['Лікар - о 17:30'] }),
    ]);

    const text = await service.build(CTX);
    expect(text).toContain('Нагадування');
    expect(text).toContain('• Лікар - о 17:30');
  });

  // spec 0024: an empty day is the greeting, a blank line and the empty-day line - nothing else.
  const EMPTY_DAY = [
    'Доброго ранку! Сьогодні 16 вересня.',
    '',
    'На сьогодні нічого немає: ні нагадувань, ні нових даних. Гарного дня! ☀️',
  ].join('\n');

  it('the empty-day line is exact and carries no bullet', () => {
    expect(DIGEST_EMPTY_DAY_LINE).toBe(
      'На сьогодні нічого немає: ні нагадувань, ні нових даних. Гарного дня! ☀️',
    );
    expect(DIGEST_EMPTY_DAY_LINE.startsWith('• ')).toBe(false);
  });

  it('every section null or empty gives the greeting plus the empty-day line', async () => {
    const service = new DigestService([
      section('none', 10, null),
      section('empty', 20, { title: 'Порожньо', lines: [] }),
    ]);
    const text = await service.build(CTX);
    expect(text).toBe(EMPTY_DAY);
    expect(text).not.toContain('Порожньо');
    expect(text).not.toContain('• ');
  });

  it('the only section throwing gives the empty-day line', async () => {
    const service = new DigestService([
      section('broken', 10, async () => {
        throw new Error('boom');
      }),
    ]);
    expect(await service.build(CTX)).toBe(EMPTY_DAY);
  });

  it('every section throwing gives the empty-day line', async () => {
    const service = new DigestService([
      section('broken-a', 10, async () => {
        throw new Error('boom');
      }),
      section('broken-b', 20, async () => {
        throw new Error('bang');
      }),
    ]);
    expect(await service.build(CTX)).toBe(EMPTY_DAY);
  });

  it('no section registered gives the empty-day line', async () => {
    expect(await new DigestService([]).build(CTX)).toBe(EMPTY_DAY);
  });

  it('a non-empty digest never carries the empty-day line', async () => {
    const service = new DigestService([
      section('empty', 10, { title: 'Порожньо', lines: [] }),
      section('reminders', 100, { title: 'Нагадування', lines: ['bread - о 12:00'] }),
    ]);
    const text = await service.build(CTX);
    expect(text).toContain('bread');
    expect(text).not.toContain('На сьогодні нічого немає');
  });

  it('hides an empty section but shows its non-empty neighbours', async () => {
    const service = new DigestService([
      section('empty', 10, { title: 'Порожньо', lines: [] }),
      section('reminders', 100, { title: 'Нагадування', lines: ['a'] }),
    ]);

    const text = await service.build(CTX);
    expect(text).not.toContain('Порожньо');
    expect(text).toContain('Нагадування');
  });

  it('caps a section at 15 lines and reports exactly how many were dropped', async () => {
    expect(DIGEST_MAX_LINES_PER_SECTION).toBe(15);
    const lines = Array.from({ length: 22 }, (_, i) => `item ${i + 1}`);
    const service = new DigestService([section('big', 1, { title: 'Багато', lines })]);

    const text = (await service.build(CTX)) ?? '';
    const bullets = text.split('\n').filter((line) => line.startsWith('• '));

    expect(bullets).toHaveLength(16);
    expect(bullets[14]).toBe('• item 15');
    expect(bullets[15]).toBe('• …і ще 7');
    expect(text).not.toContain('item 16');
  });

  it('shows exactly 15 lines with no overflow marker', async () => {
    const lines = Array.from({ length: 15 }, (_, i) => `item ${i + 1}`);
    const service = new DigestService([section('full', 1, { title: 'Рівно', lines })]);

    const text = (await service.build(CTX)) ?? '';
    expect(text.split('\n').filter((line) => line.startsWith('• '))).toHaveLength(15);
    expect(text).not.toContain('і ще');
  });

  it('reads the date in the digest zone', async () => {
    // 2026-09-30 21:30 UTC is already 1 October in Kyiv.
    const service = new DigestService([section('a', 1, { title: 'A', lines: ['x'] })]);
    const text = await service.build({
      ...CTX,
      dayStart: new Date('2026-09-30T21:00:00Z'),
      dayEnd: new Date('2026-10-01T21:00:00Z'),
    });
    expect(text?.split('\n')[0]).toBe('Доброго ранку! Сьогодні 1 жовтня.');
  });
});
