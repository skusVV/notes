import { Timestamp } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { DigestContext, DigestSection } from '../src/digest/digest.types';
import { RemindersDigestSection } from '../src/reminders/reminders-digest.section';
import { NOTIFICATIONS, RemindersService } from '../src/reminders/reminders.service';

const USER = 900000004;

const CTX: DigestContext = {
  userId: USER,
  now: new Date('2026-09-16T07:00:00+03:00'),
  timezone: 'Europe/Kyiv',
  dayStart: new Date('2026-09-16T00:00:00+03:00'),
  dayEnd: new Date('2026-09-17T00:00:00+03:00'),
};

type Doc = Record<string, unknown>;
type Filter = { field: string; op: '>=' | '<'; value: Timestamp };

/**
 * Just enough Firestore for `listForDay`: documents by path, and a collection query with range
 * filters that returns only the collection's direct children - so a reminder's notifications
 * subcollection is never mistaken for more reminders.
 */
function fakeDb(docs: Map<string, Doc>) {
  const query = (path: string, filters: Filter[]) => ({
    where: (field: string, op: Filter['op'], value: Timestamp) =>
      query(path, [...filters, { field, op, value }]),
    get: async () => ({
      docs: [...docs.entries()]
        .filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
        .filter(([, data]) =>
          filters.every(({ field, op, value }) => {
            const v = data[field];
            if (!(v instanceof Timestamp)) {
              return false;
            }
            return op === '>=' ? v.toMillis() >= value.toMillis() : v.toMillis() < value.toMillis();
          }),
        )
        .map(([key, data]) => ({ id: key.slice(key.lastIndexOf('/') + 1), data: () => data })),
    }),
  });
  const doc = (path: string) => ({ collection: (name: string) => collection(`${path}/${name}`) });
  const collection = (path: string) => ({
    doc: (id: string) => doc(`${path}/${id}`),
    ...query(path, []),
  });
  return { collection: (name: string) => collection(name) };
}

function reminder(eventAt: string, title: string, extra: Doc = {}): Doc {
  return {
    title,
    eventAt,
    eventAtUtc: Timestamp.fromDate(new Date(eventAt)),
    status: 'scheduled',
    ...extra,
  };
}

function sectionOver(seed: Record<string, Doc>, registry: DigestSection[] = []) {
  const docs = new Map(Object.entries(seed));
  const reminders = new RemindersService({ db: fakeDb(docs), available: true } as never);
  return new RemindersDigestSection(reminders, registry);
}

const base = `users/${USER}/reminders`;

describe('RemindersDigestSection', () => {
  it('lists only reminders whose event falls on today, with the event time', async () => {
    const section = sectionOver({
      [`${base}/today`]: reminder('2026-09-16T14:00:00+03:00', 'call the bank'),
      [`${base}/tomorrow`]: reminder('2026-09-17T11:00:00+03:00', 'renew the passport'),
      [`${base}/yesterday`]: reminder('2026-09-15T23:59:00+03:00', 'late one'),
      [`${base}/midnight`]: reminder('2026-09-17T00:00:00+03:00', 'next midnight'),
    });

    const result = await section.build(CTX);
    expect(result).toEqual({ title: 'Нагадування', lines: ['call the bank - о 14:00'] });
  });

  it('includes a reminder at exactly the local start of the day', async () => {
    const section = sectionOver({
      [`${base}/start`]: reminder('2026-09-16T00:00:00+03:00', 'at midnight'),
    });
    expect((await section.build(CTX))?.lines).toEqual(['at midnight - о 0:00']);
  });

  it('keeps a reminder already delivered (sent) but drops acked and cancelled ones', async () => {
    const section = sectionOver({
      [`${base}/sent`]: reminder('2026-09-16T07:10:00+03:00', 'stretch', { status: 'sent' }),
      [`${base}/acked`]: reminder('2026-09-16T09:00:00+03:00', 'done thing', { status: 'acked' }),
      [`${base}/cancelled`]: reminder('2026-09-16T10:00:00+03:00', 'dropped', {
        status: 'cancelled',
      }),
      [`${base}/scheduled`]: reminder('2026-09-16T12:00:00+03:00', 'lunch'),
    });

    expect((await section.build(CTX))?.lines).toEqual(['stretch - о 7:10', 'lunch - о 12:00']);
  });

  it('shows one line for a reminder with several notifications', async () => {
    const section = sectionOver({
      [`${base}/doctor`]: reminder('2026-09-16T14:00:00+03:00', 'doctor'),
      [`${base}/doctor/${NOTIFICATIONS}/evening`]: {
        at: Timestamp.fromDate(new Date('2026-09-15T19:00:00+03:00')),
        status: 'sent',
        title: 'doctor',
        eventAtUtc: Timestamp.fromDate(new Date('2026-09-16T14:00:00+03:00')),
      },
      [`${base}/doctor/${NOTIFICATIONS}/morning`]: {
        at: Timestamp.fromDate(new Date('2026-09-16T09:00:00+03:00')),
        status: 'scheduled',
        title: 'doctor',
        eventAtUtc: Timestamp.fromDate(new Date('2026-09-16T14:00:00+03:00')),
      },
    });

    expect((await section.build(CTX))?.lines).toEqual(['doctor - о 14:00']);
  });

  it('sorts by event time ascending, whatever the stored order', async () => {
    const section = sectionOver({
      [`${base}/c`]: reminder('2026-09-16T20:00:00+03:00', 'evening'),
      [`${base}/a`]: reminder('2026-09-16T08:00:00+03:00', 'morning'),
      [`${base}/b`]: reminder('2026-09-16T11:30:00+03:00', 'noon'),
    });

    expect((await section.build(CTX))?.lines).toEqual([
      'morning - о 8:00',
      'noon - об 11:30',
      'evening - о 20:00',
    ]);
  });

  it('shows an all-day event without a time', async () => {
    const section = sectionOver({
      [`${base}/bday`]: reminder('2026-09-16T09:00:00+03:00', 'Bob birthday', { allDay: true }),
      [`${base}/timed`]: reminder('2026-09-16T10:00:00+03:00', 'standup'),
    });

    expect((await section.build(CTX))?.lines).toEqual(['Bob birthday', 'standup - о 10:00']);
  });

  // 0023: all-day events first, then by time - even when an all-day one sorts later by its instant
  it('puts all-day events first, then the rest by time', async () => {
    const section = sectionOver({
      [`${base}/early`]: reminder('2026-09-16T07:30:00+03:00', 'run'),
      [`${base}/late`]: reminder('2026-09-16T18:00:00+03:00', 'dinner'),
      [`${base}/bday`]: reminder('2026-09-16T09:00:00+03:00', 'Bob birthday', { allDay: true }),
      [`${base}/anniv`]: reminder('2026-09-16T08:00:00+03:00', 'anniversary', { allDay: true }),
    });

    expect((await section.build(CTX))?.lines).toEqual([
      'anniversary',
      'Bob birthday',
      'run - о 7:30',
      'dinner - о 18:00',
    ]);
  });

  it('shows the all-day line as exactly the title, with no 09:00 default', async () => {
    const section = sectionOver({
      [`${base}/bday`]: reminder('2026-09-16T09:00:00+03:00', 'Bob birthday', { allDay: true }),
    });

    const lines = (await section.build(CTX))?.lines ?? [];
    expect(lines).toEqual(['Bob birthday']);
    expect(lines.join('\n')).not.toMatch(/9:00/);
  });

  it('never renders the raw ISO eventAt', async () => {
    const section = sectionOver({
      [`${base}/x`]: reminder('2026-09-16T14:00:00+03:00', 'pills'),
    });
    const lines = (await section.build(CTX))?.lines ?? [];
    expect(lines.join('\n')).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:/);
  });

  it('returns null when nothing is on today', async () => {
    const section = sectionOver({
      [`${base}/tomorrow`]: reminder('2026-09-17T11:00:00+03:00', 'later'),
      [`${base}/acked`]: reminder('2026-09-16T09:00:00+03:00', 'done', { status: 'acked' }),
    });
    expect(await section.build(CTX)).toBeNull();
  });

  it("does not read another user's reminders", async () => {
    const section = sectionOver({
      [`users/900000005/reminders/x`]: reminder('2026-09-16T14:00:00+03:00', 'not mine'),
    });
    expect(await section.build(CTX)).toBeNull();
  });

  it('returns null when the store is unavailable', async () => {
    const reminders = new RemindersService({ db: undefined, available: false } as never);
    expect(await new RemindersDigestSection(reminders, []).build(CTX)).toBeNull();
  });

  it('registers itself into the digest list once, with order 100', () => {
    const registry: DigestSection[] = [];
    const section = sectionOver({}, registry);

    section.onModuleInit();
    section.onModuleInit();

    expect(registry).toEqual([section]);
    expect(section.order).toBe(100);
    expect(section.id).toBe('reminders');
  });
});
