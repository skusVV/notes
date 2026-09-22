import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep every outbound Telegram call off the network: axios.create returns a stub whose post
// resolves, so the command handlers run to completion without touching api.telegram.org.
vi.mock('axios', () => {
  const instance = {
    post: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: Buffer.alloc(0) }),
  };
  return { default: { create: vi.fn(() => instance) }, create: vi.fn(() => instance) };
});

import { ClockService } from '../src/clock/clock.service';
import { TelegramService } from '../src/telegram/telegram.service';
import { TelegramUpdate } from '../src/telegram/telegram.types';

// The version the /version reply must echo, read from the same package.json the service reads.
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
).version;

/**
 * Build a TelegramService with the model boundaries stubbed. The command path never calls the
 * transcription or classifier services, so `available: false` is enough; ALLOWED_USERS is left
 * unset, which allows every sender.
 */
function makeService(): TelegramService {
  const config = {
    get: (key: string): string | undefined =>
      key === 'TELEGRAM_BOT_TOKEN' ? 'fake:token' : undefined,
  };
  const transcription = { available: false } as unknown;
  const classifier = { available: false } as unknown;
  const reminders = { available: false } as unknown;
  const actors = { available: false } as unknown;
  const notes = { available: false } as unknown;
  const symptoms = { available: false } as unknown;
  const clock = new ClockService();

  return new TelegramService(
    config as never,
    transcription as never,
    classifier as never,
    reminders as never,
    actors as never,
    notes as never,
    symptoms as never,
    clock,
  );
}

/** A minimal text-message update from an allowed sender. */
function textUpdate(text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 42 },
      from: { id: 777888, is_bot: false, username: 'someone' },
      text,
    },
  };
}

describe('TelegramService command routing', () => {
  let service: TelegramService;

  beforeEach(() => {
    service = makeService();
  });

  // acceptance: version-format
  it('replies to /version with "notes-bot <semver>"', async () => {
    const replies: string[] = [];
    await service.handleUpdate(textUpdate('/version'), replies);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/^notes-bot \d+\.\d+\.\d+$/);
    expect(replies[0]).toBe(`notes-bot ${PACKAGE_VERSION}`);
  });

  it('handles /version with a trailing @botname and arguments', async () => {
    const replies: string[] = [];
    await service.handleUpdate(textUpdate('/version@notes_bot now'), replies);

    expect(replies).toEqual([`notes-bot ${PACKAGE_VERSION}`]);
  });

  // acceptance: unknown-command-unchanged
  it('leaves the unknown-command fallthrough intact for /nope', async () => {
    const replies: string[] = [];
    await service.handleUpdate(textUpdate('/nope'), replies);

    expect(replies).toEqual(['I do not know /nope. Try /help.']);
  });

  it('still answers /help without treating it as a version request', async () => {
    const replies: string[] = [];
    await service.handleUpdate(textUpdate('/help'), replies);

    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toMatch(/^notes-bot /);
    expect(replies[0]).toContain('/help - this message');
  });
});
