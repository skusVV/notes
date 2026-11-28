/**
 * Just enough Firestore for `GarminDigestReader` and `GarminHistoryReader`: documents by path (with
 * `exists`), `getAll` over document refs, `set` (whole-document overwrite), and a collection query
 * with string range filters on one field that returns only the collection's direct children.
 * Records every query, `getAll` and write so a test can assert no composite index is needed and
 * which documents were written.
 *
 * Not a spec file, so vitest does not collect it - it is shared fixture code.
 */
type Doc = Record<string, unknown>;
type Filter = { field: string; op: '>=' | '<'; value: string };

export function fakeGarminDb(seed: Record<string, Doc>) {
  const docs = new Map(Object.entries(seed));
  const queries: Array<{ path: string; filters: Filter[] }> = [];
  const getAlls: string[][] = [];
  const writes: Array<{ path: string; data: Doc }> = [];

  const query = (path: string, filters: Filter[]) => ({
    where: (field: string, op: Filter['op'], value: string) =>
      query(path, [...filters, { field, op, value }]),
    get: async () => {
      queries.push({ path, filters });
      return {
        docs: [...docs.entries()]
          .filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
          .filter(([, data]) =>
            filters.every(({ field, op, value }) => {
              const v = data[field];
              if (typeof v !== 'string') {
                return false;
              }
              return op === '>=' ? v >= value : v < value;
            }),
          )
          .map(([key, data]) => ({ id: key.slice(key.lastIndexOf('/') + 1), data: () => data })),
      };
    },
  });
  const snapshot = (path: string) => ({ exists: docs.has(path), data: () => docs.get(path) });
  const doc = (path: string) => ({
    path,
    collection: (name: string) => collection(`${path}/${name}`),
    get: async () => snapshot(path),
    set: async (data: Doc) => {
      writes.push({ path, data });
      docs.set(path, data);
    },
  });
  const collection = (path: string) => ({
    doc: (id: string) => doc(`${path}/${id}`),
    ...query(path, []),
  });

  return {
    docs,
    queries,
    getAlls,
    writes,
    db: {
      collection: (name: string) => collection(name),
      getAll: async (...refs: Array<{ path: string }>) => {
        getAlls.push(refs.map((ref) => ref.path));
        return refs.map((ref) => snapshot(ref.path));
      },
    },
  };
}
