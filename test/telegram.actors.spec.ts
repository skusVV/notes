import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every outbound Telegram call is stubbed. `post` is controlled per test: a resolved value stands in
// for a real send, a rejection for the reflect-mode case where a throwaway chat id makes the send
// fail - which is the only way the synthetic message id is reached.
const mockPost = vi.fn();
vi.mock('axios', () => {
  const instance = {
    post: (...args: unknown[]) => mockPost(...args),
    get: vi.fn().mockResolvedValue({ data: Buffer.alloc(0) }),
  };
  return { default: { create: vi.fn(() => instance) }, create: vi.fn(() => instance) };
});

import { ActorsService } from '../src/actors/actors.service';
import { ClassificationResult } from '../src/classifier/classifier.types';
import { ClockService } from '../src/clock/clock.service';
import { NotesService } from '../src/notes/notes.service';
import { SymptomsService } from '../src/symptoms/symptoms.service';
import { ActorQuestion, TelegramService } from '../src/telegram/telegram.service';
import { TelegramUpdate } from '../src/telegram/telegram.types';

const USER = 900000030;
const CHAT = 900000030;
const NOW = '2026-09-16T09:00:00+03:00';
const EVENT_AT = '2026-09-18T10:00:00+03:00';

import { fakeFirestore } from './fake-firestore';

/** A classification with one reminder item and the given mentions, as the model would return it. */
function reminderResult(mentions: string[]): ClassificationResult {
  return {
    items: [
      {
        intent: 'reminder',
        confidence: 0.95,
        summary: 'a reminder',
        reminder: { title: 'привітати', eventAt: EVENT_AT },
      },
    ],
    language: 'uk',
    mentions,
    keywords: [],
  };
}

function makeService(result: ClassificationResult, seed: Record<string, Record<string, unknown>> = {}) {
  const store = fakeFirestore(seed);
  const classify = vi.fn().mockResolvedValue(result);
  const config = {
    get: (key: string): string | undefined =>
      key === 'TELEGRAM_BOT_TOKEN' ? 'fake:token' : undefined,
  };
  const transcription = { available: false };
  const classifier = { available: true, defaultTimezone: 'Europe/Kyiv', classify };
  const reminders = {
    available: true,
    create: vi.fn().mockResolvedValue('reminder-1'),
    list: vi.fn().mockResolvedValue([]),
  };
  const actors = new ActorsService({ db: store.db, available: true } as never);
  const notes = new NotesService({ db: store.db, available: true } as never);
  const symptoms = new SymptomsService({ db: store.db, available: true } as never);

  const service = new TelegramService(
    config as never,
    transcription as never,
    classifier as never,
    reminders as never,
    actors as never,
    notes as never,
    symptoms as never,
    new ClockService(),
  );

  return { service, store, actors, notes, symptoms, classify, reminders };
}

function textUpdate(text: string, messageId = 1, replyTo?: number): TelegramUpdate {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      chat: { id: CHAT },
      from: { id: USER, is_bot: false, username: 'someone' },
      text,
      ...(replyTo !== undefined ? { reply_to_message: { message_id: replyTo } } : {}),
    },
  };
}

describe('TelegramService actor capture', () => {
  beforeEach(() => {
    mockPost.mockReset();
    // The default: reflect mode against a throwaway chat, so the real send fails.
    mockPost.mockRejectedValue(new Error('404 chat not found'));
  });

  // acceptance: mention-flagged-and-actor-created (the ask half), plus the synthetic message id
  it('asks about a new mention with a locally generated id when the real send failed', async () => {
    const { service, store } = makeService(reminderResult(['Антон']));
    const replies: string[] = [];
    const asks: ActorQuestion[] = [];

    await service.handleUpdate(textUpdate('Нагадай привітати Антона'), replies, NOW, asks);

    expect(asks).toHaveLength(1);
    expect(asks[0].mention).toBe('Антон');
    // The fallback id: a real Telegram message id is a small per-chat integer, so a placeholder
    // starts far above that range. It is only reachable because the send above failed.
    expect(Number.isSafeInteger(asks[0].questionMessageId)).toBe(true);
    expect(asks[0].questionMessageId).toBeGreaterThanOrEqual(1_000_000_000);

    // The question is a native reply to the user's own message, not to the bot's confirmation.
    const sent = mockPost.mock.calls.map(([, body]) => body as Record<string, unknown>);
    const question = sent.find((body) => body.reply_to_message_id !== undefined);
    expect(question?.reply_to_message_id).toBe(1);

    // Pending state lives in Firestore, keyed by the id that was actually sent.
    expect(store.docs.get(`users/${USER}/pending/${CHAT}`)).toMatchObject({
      kind: 'actor_confirm',
      mention: 'Антон',
      questionMessageId: asks[0].questionMessageId,
    });
  });

  it('returns the real Telegram message id when the send succeeded', async () => {
    mockPost.mockResolvedValue({ data: { ok: true, result: { message_id: 4242 } } });
    const { service } = makeService(reminderResult(['Антон']));
    const asks: ActorQuestion[] = [];

    await service.handleUpdate(textUpdate('Нагадай привітати Антона'), [], NOW, asks);

    expect(asks[0].questionMessageId).toBe(4242);
  });

  // acceptance: at-most-one-question-per-message
  it('asks about only the first new mention, never two', async () => {
    const { service } = makeService(reminderResult(['Антон', 'Олена']));
    const asks: ActorQuestion[] = [];

    await service.handleUpdate(textUpdate('Нагадай привітати Антона і подзвонити Олені'), [], NOW, asks);

    expect(asks).toHaveLength(1);
    expect(['Антон', 'Олена']).toContain(asks[0].mention);
  });

  // acceptance: known-actor-not-reasked
  it('never asks about a known actor', async () => {
    const { service } = makeService(reminderResult(['Марія']), {
      [`users/${USER}/actors/a1`]: { name: 'Марія', aliases: ['Марія'] },
    });
    const asks: ActorQuestion[] = [];

    await service.handleUpdate(textUpdate('Нагадай передати документи Марії'), [], NOW, asks);

    expect(asks).toEqual([]);
  });

  // acceptance: decline-stops-future-asks (the second half - a declined mention is not re-asked)
  it('never asks about a declined mention', async () => {
    const { service } = makeService(reminderResult(['Олена']), {
      [`users/${USER}`]: { declinedMentions: ['олена'] },
    });
    const asks: ActorQuestion[] = [];

    await service.handleUpdate(textUpdate('Нагадай написати Олені'), [], NOW, asks);

    expect(asks).toEqual([]);
  });

  // acceptance: generic-role-not-flagged - no mention, so nothing to ask about
  it('asks nothing when the message named no person', async () => {
    const { service } = makeService(reminderResult([]));
    const asks: ActorQuestion[] = [];

    await service.handleUpdate(textUpdate('Нагадай записатися до лікаря'), [], NOW, asks);

    expect(asks).toEqual([]);
  });

  it('asks nothing when the message produced no reminder', async () => {
    const note: ClassificationResult = {
      items: [{ intent: 'note', confidence: 0.9, summary: 'a note' }],
      language: 'uk',
      mentions: ['Антон'],
      keywords: [],
    };
    const { service } = makeService(note);
    const asks: ActorQuestion[] = [];

    await service.handleUpdate(textUpdate('Антон купив машину'), [], NOW, asks);

    expect(asks).toEqual([]);
  });
});

describe('TelegramService actor answers', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockRejectedValue(new Error('404 chat not found'));
  });

  /** Runs the ask half and returns the id the answer has to reply to. */
  async function ask(context: ReturnType<typeof makeService>): Promise<number> {
    const asks: ActorQuestion[] = [];
    await context.service.handleUpdate(textUpdate('Нагадай привітати Антона'), [], NOW, asks);
    return asks[0].questionMessageId;
  }

  // acceptance: mention-flagged-and-actor-created (the answer half)
  it('stores the reply verbatim as the new actor, without classifying it', async () => {
    const context = makeService(reminderResult(['Антон']));
    const questionMessageId = await ask(context);
    context.classify.mockClear();

    await context.service.handleUpdate(
      textUpdate('Антон - мій товариш, разом вчилися в університеті', 2, questionMessageId),
      [],
      NOW,
    );

    // The answer is an answer, not a new message: classification is skipped entirely.
    expect(context.classify).not.toHaveBeenCalled();

    const stored = await context.actors.list(USER);
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Антон');
    expect(stored[0].aliases).toContain('Антон');
    expect(stored[0].notes).toContain('товариш');
    // The question is closed either way, so the next reply is an ordinary message again.
    expect(context.store.docs.has(`users/${USER}/pending/${CHAT}`)).toBe(false);
  });

  // acceptance: decline-stops-future-asks (the answer half)
  it('records a decline instead of an actor when the reply is "ні"', async () => {
    const context = makeService(reminderResult(['Антон']));
    const questionMessageId = await ask(context);

    await context.service.handleUpdate(textUpdate('ні', 2, questionMessageId), [], NOW);

    expect(await context.actors.list(USER)).toEqual([]);
    expect(await context.actors.listDeclined(USER)).toEqual(['антон']);
    expect(await context.actors.resolve(USER, 'Антон')).toBe('declined');
  });

  // acceptance: stale-reply-not-intercepted
  it('handles a reply that matches no open question as an ordinary message', async () => {
    const context = makeService(reminderResult([]));
    const replies: string[] = [];

    await context.service.handleUpdate(
      textUpdate('Нагадай оплатити комуналку', 5, 999999999),
      replies,
      NOW,
    );

    // Not swallowed: it went through classification and the reminder was stored.
    expect(context.classify).toHaveBeenCalledTimes(1);
    expect(context.reminders.create).toHaveBeenCalledTimes(1);
  });

  it('ignores an expired question, so the reply is handled as a new message', async () => {
    const context = makeService(reminderResult(['Антон']));
    const questionMessageId = await ask(context);
    context.classify.mockClear();
    context.classify.mockResolvedValue(reminderResult([]));

    // A day and an hour later the question is no longer answerable.
    await context.service.handleUpdate(
      textUpdate('Антон - мій товариш', 2, questionMessageId),
      [],
      '2026-09-17T10:00:00+03:00',
    );

    expect(context.classify).toHaveBeenCalledTimes(1);
    expect(await context.actors.list(USER)).toEqual([]);
  });
});

describe('TelegramService /export', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockRejectedValue(new Error('404 chat not found'));
  });

  // acceptance: export-actors-empty-shape / export-has-symptoms-key
  // (now four keys - notes landed in 0007, symptoms in 0011)
  it('returns all four keys, empty, for a user with nothing stored', async () => {
    const { service } = makeService(reminderResult([]));
    const replies: string[] = [];

    await service.handleUpdate(textUpdate('/export'), replies, NOW);

    expect(replies).toHaveLength(1);
    expect(JSON.parse(replies[0])).toEqual({ reminders: [], actors: [], notes: [], symptoms: [] });
  });

  it('lists a stored actor with its id, aliases, notes and ISO createdAt', async () => {
    const context = makeService(reminderResult(['Антон']));
    const asks: ActorQuestion[] = [];
    await context.service.handleUpdate(textUpdate('Нагадай привітати Антона'), [], NOW, asks);
    await context.service.handleUpdate(
      textUpdate('мій товариш', 2, asks[0].questionMessageId),
      [],
      NOW,
    );

    const replies: string[] = [];
    await context.service.handleUpdate(textUpdate('/export', 3), replies, NOW);

    const exported = JSON.parse(replies[0]) as {
      actors: { id: string; name: string; aliases: string[]; notes: string; createdAt: string }[];
    };
    expect(exported.actors).toHaveLength(1);
    expect(exported.actors[0]).toMatchObject({
      name: 'Антон',
      aliases: ['Антон'],
      notes: 'мій товариш',
      createdAt: new Date(NOW).toISOString(),
    });
    expect(exported.actors[0].id).toBeTruthy();
  });
});
