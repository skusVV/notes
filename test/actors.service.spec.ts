import { Timestamp } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { fakeFirestore } from './fake-firestore';
import {
  ActorResolution,
  ActorsService,
  firstNewMention,
  isDeclineReply,
  normalizeMention,
} from '../src/actors/actors.service';

const USER = 900000010;
const CHAT = 900000010;
const NOW = new Date('2026-09-16T09:00:00+03:00');

function makeService(seed: Record<string, Record<string, unknown>> = {}) {
  const store = fakeFirestore(seed);
  return { store, service: new ActorsService({ db: store.db, available: true } as never) };
}

/** A user who already knows Марія and has already declined "лікар". */
function seededService() {
  return makeService({
    [`users/${USER}`]: { declinedMentions: ['лікар'] },
    [`users/${USER}/actors/a1`]: {
      name: 'Марія',
      aliases: ['Марія'],
      notes: 'колега з роботи',
      createdAt: Timestamp.fromDate(NOW),
    },
  });
}

describe('isDeclineReply', () => {
  // acceptance: decline-stops-future-asks - the exact closed list, nothing else counts as "no"
  it('matches every decline phrase, case-insensitively', () => {
    for (const phrase of ['no', 'nope', 'ні', 'нет', 'не', 'not a person', 'не людина']) {
      expect(isDeclineReply(phrase)).toBe(true);
      expect(isDeclineReply(phrase.toUpperCase())).toBe(true);
      expect(isDeclineReply(`  ${phrase}  `)).toBe(true);
    }
  });

  it('strips one trailing . ! or ?', () => {
    expect(isDeclineReply('ні.')).toBe(true);
    expect(isDeclineReply('No!')).toBe(true);
    expect(isDeclineReply('nope?')).toBe(true);
    // Only one is stripped, so this is not a decline - and treating it as information is the safe
    // way to be wrong: a real answer is never thrown away.
    expect(isDeclineReply('ні..')).toBe(false);
  });

  it('treats anything else as information about the person', () => {
    expect(isDeclineReply('Антон - мій товариш, разом вчилися в університеті')).toBe(false);
    expect(isDeclineReply('no idea, some guy from work')).toBe(false);
    expect(isDeclineReply('нема')).toBe(false);
    expect(isDeclineReply('')).toBe(false);
  });
});

describe('normalizeMention', () => {
  it('trims and lowercases, and nothing else', () => {
    expect(normalizeMention('  Антон ')).toBe('антон');
    expect(normalizeMention('Not A Person')).toBe('not a person');
  });
});

describe('ActorsService.resolve', () => {
  // acceptance: known-actor-not-reasked / decline-stops-future-asks - the app-level backstop
  it('reports known, declined and new against a fixture', async () => {
    const { service } = seededService();

    expect(await service.resolve(USER, 'Марія')).toBe('known');
    expect(await service.resolve(USER, 'лікар')).toBe('declined');
    expect(await service.resolve(USER, 'Антон')).toBe('new');
  });

  it('matches names and declines case-insensitively and ignores surrounding space', async () => {
    const { service } = seededService();

    expect(await service.resolve(USER, ' марія ')).toBe('known');
    expect(await service.resolve(USER, 'Лікар')).toBe('declined');
  });

  it('matches an alias as well as the name', async () => {
    const { service } = makeService({
      [`users/${USER}/actors/a1`]: { name: 'Марія', aliases: ['Марія', 'Маша'] },
    });

    expect(await service.resolve(USER, 'Маша')).toBe('known');
  });

  it('never reports new when the store is unavailable', async () => {
    const service = new ActorsService({ db: undefined, available: false } as never);

    // With nowhere to record an answer, the bot must not ask a question it cannot remember asking.
    expect(await service.resolve(USER, 'Антон')).toBe('declined');
    expect(await service.list(USER)).toEqual([]);
    expect(await service.listKnown(USER)).toEqual([]);
    expect(await service.listDeclined(USER)).toEqual([]);
    expect(await service.getPendingQuestion(USER, CHAT, NOW)).toBeUndefined();
    await expect(service.create(USER, { name: 'Антон', notes: 'x' }, NOW)).resolves.toBeUndefined();
    await expect(service.decline(USER, 'лікар')).resolves.toBeUndefined();
  });
});

describe('ActorsService writes', () => {
  it('creates an actor with the name as its only alias and the reply as notes', async () => {
    const { store, service } = makeService();

    await service.create(USER, { name: 'Антон', notes: 'мій товариш' }, NOW);

    const [stored] = await service.list(USER);
    expect(stored.name).toBe('Антон');
    expect(stored.aliases).toEqual(['Антон']);
    expect(stored.notes).toBe('мій товариш');
    expect(stored.createdAt).toBe(NOW.toISOString());
    // relation and birthday are deliberately not collected in this spec.
    const written = [...store.docs.values()].find((doc) => doc.name === 'Антон');
    expect(written).not.toHaveProperty('relation');
    expect(written).not.toHaveProperty('birthday');
  });

  it('records a declined mention normalised, on the user document, without duplicates', async () => {
    const { store, service } = makeService();

    await service.decline(USER, ' Лікар ');
    await service.decline(USER, 'лікар');

    expect(store.docs.get(`users/${USER}`)?.declinedMentions).toEqual(['лікар']);
    expect(await service.listDeclined(USER)).toEqual(['лікар']);
    expect(await service.resolve(USER, 'Лікар')).toBe('declined');
  });

  it('keeps one pending question per chat, expires it, and clears it', async () => {
    const { store, service } = makeService();

    await service.setPendingQuestion(USER, CHAT, { mention: 'Антон', questionMessageId: 11 }, NOW);
    expect(await service.getPendingQuestion(USER, CHAT, NOW)).toEqual({
      mention: 'Антон',
      questionMessageId: 11,
    });

    // One slot: a second question overwrites the unanswered first rather than queueing.
    await service.setPendingQuestion(USER, CHAT, { mention: 'Олена', questionMessageId: 12 }, NOW);
    expect(await service.getPendingQuestion(USER, CHAT, NOW)).toEqual({
      mention: 'Олена',
      questionMessageId: 12,
    });
    expect(store.docs.get(`users/${USER}/pending/${CHAT}`)?.kind).toBe('actor_confirm');
    // expiresAt is the field the TTL policy targets, 24h after the question.
    const expiresAt = store.docs.get(`users/${USER}/pending/${CHAT}`)?.expiresAt as Timestamp;
    expect(expiresAt.toDate()).toEqual(new Date(NOW.getTime() + 24 * 3_600_000));

    // An unanswered question stops being answerable on time, not on the TTL sweep's schedule.
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    expect(await service.getPendingQuestion(USER, CHAT, later)).toBeUndefined();

    await service.clearPendingQuestion(USER, CHAT);
    expect(await service.getPendingQuestion(USER, CHAT, NOW)).toBeUndefined();
  });
});

describe('firstNewMention', () => {
  /** Resolves against fixed sets, and records what it was asked about. */
  function resolver(known: string[], declined: string[], asked: string[]) {
    return async (mention: string): Promise<ActorResolution> => {
      asked.push(mention);
      if (known.includes(mention)) return 'known';
      if (declined.includes(mention)) return 'declined';
      return 'new';
    };
  }

  it('returns undefined when there are no mentions at all', async () => {
    const asked: string[] = [];
    expect(await firstNewMention([], resolver([], [], asked))).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('returns undefined when every mention is already known or declined', async () => {
    const asked: string[] = [];
    expect(
      await firstNewMention(['Марія', 'лікар'], resolver(['Марія'], ['лікар'], asked)),
    ).toBeUndefined();
    expect(asked).toEqual(['Марія', 'лікар']);
  });

  it('returns the single new mention', async () => {
    const asked: string[] = [];
    expect(await firstNewMention(['Антон'], resolver([], [], asked))).toBe('Антон');
  });

  // acceptance: at-most-one-question-per-message - two new names still produce one candidate
  it('returns only the first new mention and stops resolving there', async () => {
    const asked: string[] = [];
    expect(await firstNewMention(['Антон', 'Олена'], resolver([], [], asked))).toBe('Антон');
    expect(asked).toEqual(['Антон']);
  });

  it('skips settled mentions before the first new one', async () => {
    const asked: string[] = [];
    expect(
      await firstNewMention(['лікар', 'Марія', 'Антон', 'Олена'], resolver(['Марія'], ['лікар'], asked)),
    ).toBe('Антон');
    expect(asked).toEqual(['лікар', 'Марія', 'Антон']);
  });

  it('ignores blanks and resolves a repeated mention once', async () => {
    const asked: string[] = [];
    expect(await firstNewMention(['', '  ', 'Марія', 'марія'], resolver(['Марія'], [], asked))).toBeUndefined();
    expect(asked).toEqual(['Марія']);
  });
});
