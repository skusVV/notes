import { FieldValue } from '@google-cloud/firestore';

/**
 * A minimal in-memory Firestore for the actor tests: documents keyed by path, nested collections by
 * path prefix, and the one field transform the services use (`arrayUnion`). Enough to exercise every
 * read and write without a database.
 *
 * Not a spec file, so vitest does not collect it - it is shared fixture code.
 */
export function fakeFirestore(seed: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, unknown>>(Object.entries(seed));
  let auto = 0;

  const applyValue = (existing: unknown, value: unknown): unknown => {
    if (value instanceof FieldValue) {
      // Only arrayUnion is modelled - it is the only transform written here.
      const elements = (value as unknown as { elements?: unknown[] }).elements ?? [];
      const current = Array.isArray(existing) ? existing : [];
      return [...current, ...elements.filter((entry) => !current.includes(entry))];
    }
    return value;
  };

  const docRef = (path: string) => ({
    id: path.slice(path.lastIndexOf('/') + 1),
    path,
    collection: (name: string) => collectionRef(`${path}/${name}`),
    get: async () => ({
      id: path.slice(path.lastIndexOf('/') + 1),
      exists: docs.has(path),
      data: () => docs.get(path),
    }),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      const base = options?.merge ? (docs.get(path) ?? {}) : {};
      const next: Record<string, unknown> = { ...base };
      for (const [key, value] of Object.entries(data)) {
        next[key] = applyValue(base[key], value);
      }
      docs.set(path, next);
    },
    delete: async () => {
      docs.delete(path);
    },
  });

  const collectionRef = (path: string) => {
    const ref = {
      doc: (id?: string) => docRef(`${path}/${id ?? `auto${++auto}`}`),
      // Ordering is insertion order: a Map preserves it, and every test writes in the order it
      // expects to read back.
      orderBy: () => ref,
      get: async () => ({
        docs: [...docs.entries()]
          .filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
          .map(([key, data]) => ({ id: key.slice(key.lastIndexOf('/') + 1), data: () => data })),
      }),
    };
    return ref;
  };

  return { docs, db: { collection: (name: string) => collectionRef(name) } };
}
