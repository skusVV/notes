import { DigestSettingsService } from '../src/digest/digest-settings.service';

type Doc = Record<string, unknown>;

const isMap = (value: unknown): value is Doc =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Firestore's `set(..., { merge: true })`: nested maps merge key by key, everything else replaces. */
function deepMerge(base: Doc, patch: Doc): Doc {
  const next: Doc = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = isMap(value) && isMap(base[key]) ? deepMerge(base[key] as Doc, value) : value;
  }
  return next;
}

/**
 * A minimal in-memory store for `users/{id}` documents, with merge writes and a transaction - all
 * `DigestSettingsService` touches. `beforeTransaction`, when set, runs just before a transaction
 * reads, which is how a test makes an overlapping caller win the claim race.
 *
 * Not a spec file, so vitest does not collect it - it is shared fixture code.
 */
export function fakeDigestStore(seed: Record<string, Doc> = {}) {
  const docs = new Map<string, Doc>(Object.entries(seed));
  const hooks: { beforeTransaction?: () => void } = {};

  const ref = (path: string) => ({
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (data: Doc, options?: { merge?: boolean }) => {
      docs.set(path, options?.merge ? deepMerge(docs.get(path) ?? {}, data) : data);
    },
  });

  const db = {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: async <T>(
      fn: (tx: {
        get: (r: { path: string }) => Promise<{ exists: boolean; data: () => Doc | undefined }>;
        set: (r: { path: string }, data: Doc, options?: { merge?: boolean }) => void;
      }) => Promise<T>,
    ): Promise<T> => {
      hooks.beforeTransaction?.();
      const writes: Array<() => void> = [];
      const result = await fn({
        get: async (r) => ({ exists: docs.has(r.path), data: () => docs.get(r.path) }),
        set: (r, data, options) =>
          writes.push(() =>
            docs.set(r.path, options?.merge ? deepMerge(docs.get(r.path) ?? {}, data) : data),
          ),
      });
      writes.forEach((write) => write());
      return result;
    },
  };

  const settings = new DigestSettingsService({ db, available: true } as never);
  return { docs, db, hooks, settings };
}
