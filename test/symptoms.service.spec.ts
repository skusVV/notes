import { Timestamp } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { SymptomsService } from '../src/symptoms/symptoms.service';
import { fakeFirestore } from './fake-firestore';

const USER = 900000050;
const CHAT = 900000050;
const NOW = new Date('2026-09-16T09:00:00+03:00');

function makeService() {
  const store = fakeFirestore();
  const service = new SymptomsService({ db: store.db, available: true } as never);
  return { service, store };
}

/** The raw document written under users/{user}/symptoms, for asserting on stored keys directly. */
function storedSymptom(store: ReturnType<typeof fakeFirestore>): Record<string, unknown> {
  const entry = [...store.docs.entries()].find(([key]) =>
    key.startsWith(`users/${USER}/symptoms/`),
  );
  if (!entry) {
    throw new Error('no symptom document was written');
  }
  return entry[1];
}

describe('SymptomsService', () => {
  it('degrades when the store is unavailable: no write, undefined id, empty reads', async () => {
    const service = new SymptomsService({ db: undefined, available: false } as never);

    expect(service.available).toBe(false);
    expect(await service.create(USER, CHAT, { type: 'headache' }, 'болить голова', NOW)).toBeUndefined();
    expect(await service.list(USER)).toEqual([]);
    expect(await service.listKnownTypes(USER)).toEqual([]);
  });

  // Invariant: absent stays absent. A field the draft did not carry is never persisted as 0, null
  // or '' - absence is the meaningful "not stated" state.
  it('writes only the fields the draft carries', async () => {
    const { service, store } = makeService();

    const id = await service.create(USER, CHAT, { type: 'headache' }, 'болить голова', NOW);
    expect(id).toBeTruthy();

    const doc = storedSymptom(store);
    expect(doc.type).toBe('headache');
    expect(doc.originalText).toBe('болить голова');
    expect(doc.userId).toBe(USER);
    expect(doc.chatId).toBe(CHAT);
    expect(doc.createdAt).toBeInstanceOf(Timestamp);
    // The optional fields must be entirely absent, not present-but-empty.
    expect('severity' in doc).toBe(false);
    expect('startedAt' in doc).toBe(false);
    expect('durationMinutes' in doc).toBe(false);
    expect('notes' in doc).toBe(false);
  });

  it('writes every optional field the draft does carry', async () => {
    const { service, store } = makeService();

    await service.create(
      USER,
      CHAT,
      {
        type: 'headache',
        severity: 7,
        startedAt: '2026-09-16T09:00:00+03:00',
        durationMinutes: 30,
        notes: 'behind the eyes',
      },
      'болить голова, десь на 7 з 10',
      NOW,
    );

    const doc = storedSymptom(store);
    expect(doc.severity).toBe(7);
    expect(doc.startedAt).toBe('2026-09-16T09:00:00+03:00');
    expect(doc.durationMinutes).toBe(30);
    expect(doc.notes).toBe('behind the eyes');
  });

  // The export renders absence as an explicit null (or '' for notes), so a reader tells "not stated"
  // from a real value.
  it('renders absent fields as null in the export, notes as empty string', async () => {
    const { service } = makeService();
    await service.create(USER, CHAT, { type: 'headache' }, 'болить голова', NOW);

    const [exported] = await service.list(USER);
    expect(exported.type).toBe('headache');
    expect(exported.severity).toBeNull();
    expect(exported.startedAt).toBeNull();
    expect(exported.durationMinutes).toBeNull();
    expect(exported.notes).toBe('');
    expect(exported.createdAt).toBe(NOW.toISOString());
  });

  it('lists distinct known type slugs, folding repeats', async () => {
    const { service } = makeService();
    await service.create(USER, CHAT, { type: 'headache' }, 'болить голова', NOW);
    await service.create(USER, CHAT, { type: 'headache' }, 'знову розколюється голова', NOW);
    await service.create(USER, CHAT, { type: 'nausea' }, 'нудить', NOW);

    const types = await service.listKnownTypes(USER);
    expect([...types].sort()).toEqual(['headache', 'nausea']);
  });
});
