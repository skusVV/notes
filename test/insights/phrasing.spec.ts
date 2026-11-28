import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptPhrase,
  applyPhrasing,
  InsightPhrasingService,
  PHRASING_TIMEOUT_MS,
} from '../../src/insights/insight-phrasing.service';
import { PlannedLine } from '../../src/insights/rank';
import { ALL_NORMAL_LINE } from '../../src/insights/templates';

const READINESS: PlannedLine = {
  id: 'readiness',
  marker: '🟡',
  template: 'Готовність: середня, бо HRV 41 мс нижче базової лінії.',
  numbers: ['41'],
};
const DEBT: PlannedLine = {
  id: 'sleep-debt',
  template: 'За 7 ночей набігло 3 год 20 хв недосипу від твоєї потреби сну.',
  numbers: ['3 год 20 хв'],
};
const CALORIES: PlannedLine = {
  id: 'calories:up',
  template: 'Активних калорій за тиждень у середньому 600 на день проти 500 тижнем раніше (+20%).',
  numbers: ['600', '500', '+20%'],
};
const LINES = [READINESS, DEBT, CALORIES];

const reply = (items: Array<{ id: string; text: string }>) => JSON.stringify(items);

describe('acceptPhrase', () => {
  it('accepts a single line that keeps every number verbatim', () => {
    expect(acceptPhrase(DEBT, 'Тиждень набрав 3 год 20 хв недосипу - час віддати борг подушці.')).toBe(true);
  });

  it('rejects a changed number, a line break, over 200 characters, empty or non-string', () => {
    expect(acceptPhrase(DEBT, 'Тиждень набрав 3 год 21 хв недосипу.')).toBe(false);
    expect(acceptPhrase(DEBT, 'Тиждень набрав\n3 год 20 хв недосипу.')).toBe(false);
    expect(acceptPhrase(DEBT, `3 год 20 хв ${'а'.repeat(200)}`)).toBe(false);
    expect(acceptPhrase(DEBT, '   ')).toBe(false);
    expect(acceptPhrase(DEBT, 42)).toBe(false);
    expect(acceptPhrase(CALORIES, 'Калорій більше: 600 проти 500, +2%.')).toBe(false);
  });
});

describe('applyPhrasing', () => {
  it('a valid reply replaces every line', () => {
    const result = applyPhrasing(
      LINES,
      reply([
        { id: 'readiness', text: '🟡 HRV 41 мс просів, тож сьогодні без героїзму.' },
        { id: 'sleep-debt', text: 'За тиждень 3 год 20 хв недосипу, подушка чекає.' },
        { id: 'calories:up', text: 'Ти розігнався: 600 активних калорій на день проти 500, це +20%.' },
      ]),
    );
    expect(result.fallback).toBe(0);
    // The model's own marker is dropped; the section prepends the code's.
    expect(result.texts[0]).toBe('HRV 41 мс просів, тож сьогодні без героїзму.');
    expect(result.texts[2]).toContain('+20%');
  });

  it('per line: a changed number or a missing id keeps that line\'s template; an extra id is ignored', () => {
    const result = applyPhrasing(
      LINES,
      reply([
        { id: 'readiness', text: 'HRV 40 мс просів.' },
        { id: 'sleep-debt', text: 'За тиждень 3 год 20 хв недосипу.' },
        { id: 'invented', text: 'Новий факт 99.' },
      ]),
    );
    expect(result.texts).toEqual([READINESS.template, 'За тиждень 3 год 20 хв недосипу.', CALORIES.template]);
    expect(result.fallback).toBe(2);
  });

  it('garbage, not an array, or nothing: all templates', () => {
    for (const raw of ['not json', '{"id":"x"}', undefined, '']) {
      const result = applyPhrasing(LINES, raw);
      expect(result.texts).toEqual(LINES.map((l) => l.template));
      expect(result.fallback).toBe(3);
    }
  });

  it('a fixed line is never rewritten or counted', () => {
    const fixed: PlannedLine = { id: 'all-normal', template: ALL_NORMAL_LINE, numbers: [], fixed: true };
    const result = applyPhrasing([fixed], reply([{ id: 'all-normal', text: 'Все супер!' }]));
    expect(result).toEqual({ texts: [ALL_NORMAL_LINE], fallback: 0 });
  });
});

/** The service with the network call replaced. */
class StubPhrasing extends InsightPhrasingService {
  constructor(private readonly answer: (signal: AbortSignal) => Promise<string | undefined>) {
    super({ get: (key: string) => (key === 'GCP_PROJECT' ? 'test-project' : undefined) } as never);
  }
  calls = 0;
  protected override async generate(_lines: readonly PlannedLine[], signal: AbortSignal) {
    this.calls += 1;
    return this.answer(signal);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('InsightPhrasingService.phrase', () => {
  it('without GCP_PROJECT: unavailable, templates, no call', async () => {
    const service = new InsightPhrasingService({ get: () => undefined } as never);
    expect(service.available).toBe(false);
    expect(await service.phrase(LINES)).toEqual({ texts: LINES.map((l) => l.template), fallback: 3 });
  });

  it('one call for all lines, validated per line', async () => {
    const service = new StubPhrasing(async () => reply([{ id: 'sleep-debt', text: 'Борг сну: 3 год 20 хв.' }]));
    const result = await service.phrase(LINES);
    expect(service.calls).toBe(1);
    expect(result.texts[1]).toBe('Борг сну: 3 год 20 хв.');
    expect(result.fallback).toBe(2);
  });

  it('an error gives every template', async () => {
    const service = new StubPhrasing(async () => {
      throw new Error('PERMISSION_DENIED');
    });
    expect(await service.phrase(LINES)).toEqual({ texts: LINES.map((l) => l.template), fallback: 3 });
  });

  it(`a reply slower than ${PHRASING_TIMEOUT_MS} ms gives every template and aborts the call`, async () => {
    vi.useFakeTimers();
    let aborted = false;
    const service = new StubPhrasing(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          setTimeout(() => resolve(reply([{ id: 'sleep-debt', text: 'Борг 3 год 20 хв.' }])), PHRASING_TIMEOUT_MS + 1000);
        }),
    );
    const pending = service.phrase(LINES);
    await vi.advanceTimersByTimeAsync(PHRASING_TIMEOUT_MS);
    expect(await pending).toEqual({ texts: LINES.map((l) => l.template), fallback: 3 });
    expect(aborted).toBe(true);
  });

  it('only fixed lines: no call at all', async () => {
    const service = new StubPhrasing(async () => '[]');
    const fixed: PlannedLine = { id: 'all-normal', template: ALL_NORMAL_LINE, numbers: [], fixed: true };
    expect(await service.phrase([fixed])).toEqual({ texts: [ALL_NORMAL_LINE], fallback: 0 });
    expect(service.calls).toBe(0);
  });
});
