/**
 * Just enough Firestore for `GarminDigestReader`: documents by path (with `exists`), and a
 * collection query with string range filters on one field that returns only the collection's direct
 * children. Records every query so a test can assert no composite index is needed.
 *
 * Not a spec file, so vitest does not collect it - it is shared fixture code.
 */
type Doc = Record<string, unknown>;
type Filter = { field: string; op: '>=' | '<'; value: string };

export function fakeGarminDb(seed: Record<string, Doc>) {
  const docs = new Map(Object.entries(seed));
  const queries: Array<{ path: string; filters: Filter[] }> = [];

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
  const doc = (path: string) => ({
    collection: (name: string) => collection(`${path}/${name}`),
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
  });
  const collection = (path: string) => ({
    doc: (id: string) => doc(`${path}/${id}`),
    ...query(path, []),
  });

  return { docs, queries, db: { collection: (name: string) => collection(name) } };
}
