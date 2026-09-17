import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockService } from '../src/clock/clock.service';
import { TelegramController } from '../src/telegram/telegram.controller';

const SWEEP_SECRET = 'sweep-secret-value';

function makeController(options: { secret?: string; reflect?: boolean } = {}) {
  const { secret = SWEEP_SECRET, reflect = false } = options;
  const sweeper = {
    get secret() {
      return secret || undefined;
    },
    sweep: vi.fn().mockResolvedValue(0),
  };
  const config = {
    get: (key: string): string | undefined =>
      key === 'TEST_REFLECT_REPLY' ? String(reflect) : undefined,
  };

  const controller = new TelegramController(
    { handleUpdate: vi.fn() } as never,
    sweeper as never,
    new ClockService(),
    config as never,
  );
  return { controller, sweeper };
}

describe('POST /sweep auth', () => {
  let made: ReturnType<typeof makeController>;

  beforeEach(() => {
    made = makeController();
  });

  // acceptance: sweep-auth - a missing or wrong secret is 401 and delivers nothing
  it('rejects a missing X-Sweep-Secret without sweeping', async () => {
    await expect(made.controller.sweep(undefined, undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(made.sweeper.sweep).not.toHaveBeenCalled();
  });

  it('rejects a wrong X-Sweep-Secret without sweeping', async () => {
    for (const wrong of ['', 'nope', `${SWEEP_SECRET}x`, SWEEP_SECRET.slice(0, -1)]) {
      await expect(made.controller.sweep(wrong, undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
    expect(made.sweeper.sweep).not.toHaveBeenCalled();
  });

  it('fails closed when REMINDER_SWEEP_SECRET is not configured at all', async () => {
    const unconfigured = makeController({ secret: '' });

    await expect(unconfigured.controller.sweep(SWEEP_SECRET, undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(unconfigured.sweeper.sweep).not.toHaveBeenCalled();
  });

  it('accepts the right secret and answers 200 with no reflection in production', async () => {
    expect(await made.controller.sweep(SWEEP_SECRET, undefined)).toEqual({ ok: true });
    expect(made.sweeper.sweep).toHaveBeenCalledTimes(1);
  });

  it('ignores X-Test-Now unless reflection is on', async () => {
    const before = Date.now();
    await made.controller.sweep(SWEEP_SECRET, '2026-09-16T09:45:00+03:00');

    const [now, sink] = made.sweeper.sweep.mock.calls[0];
    expect(sink).toBeUndefined();
    expect((now as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('pins now and reflects deliveries on the test function', async () => {
    const reflecting = makeController({ reflect: true });
    reflecting.sweeper.sweep.mockImplementation(async (_now: Date, sink?: string[]) => {
      sink?.push('Reminder: something');
      return 1;
    });

    const body = await reflecting.controller.sweep(SWEEP_SECRET, '2026-09-16T09:45:00+03:00');

    expect(body).toEqual({ ok: true, replies: ['Reminder: something'] });
    expect((reflecting.sweeper.sweep.mock.calls[0][0] as Date).toISOString()).toBe(
      '2026-09-16T06:45:00.000Z',
    );
  });

  it('still answers 200 when the sweep itself throws, so Cloud Scheduler does not retry', async () => {
    made.sweeper.sweep.mockRejectedValueOnce(new Error('firestore is down'));

    expect(await made.controller.sweep(SWEEP_SECRET, undefined)).toEqual({ ok: true });
  });
});
