# Writing a storage adapter

antiflow persists execution state through a `StorageAdapter` that the host supplies when it
creates the engine:

```ts
const engine = createEngine({ storage: createPostgresAdapter(pool) });
```

Only the in-memory adapter (`createInMemoryStorage()`) ships with antiflow. It is the
reference: any other adapter should behave the same way.

## The interface

```ts
interface StorageAdapter {
  saveRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  saveNodeRecord(record: NodeRecord): Promise<void>;
  listNodeRecords(runId: string): Promise<NodeRecord[]>;
}
```

- **Run records** are keyed by `id`. A run record holds its status, timestamps, the input the
  run was started with, and the workflow snapshot the run executes.
- **Node records** are keyed by `runId` + `nodeId`, one per node of the run. A node record
  holds its status, attempt, result (`output` or `outputsByPort`), error and timestamps.
- `listNodeRecords` returns every node record of one run, in any order. For a run with no
  node records it returns an empty array.

## Rules

1. **Saves replace whole records.** A save is an upsert that replaces the stored record with
   the same key. It is not a merge: fields missing from the new record must be gone
   afterwards. The engine relies on this, for example to clear a node's `error` when a retry
   succeeds, or a run's `completedAt` when it's resumed.
2. **No transactions.** The engine never needs two writes to commit together. Each call
   stands alone, which is why antiflow's execution guarantee is at-least-once (see the
   README).
3. **JSON in, the same JSON out.** Records hold only JSON values (strings, numbers,
   booleans, null, arrays, plain objects). They must read back structurally equal. Storing
   them as a JSON column is fine. Dropping properties whose value is `undefined` is fine too.
4. **No shared references.** Mutating an object after passing it to a save, or after
   reading it back, must not change what's stored. Adapters that serialize get this for
   free.
5. **Keep runs apart.** Records of one run are never returned for another.

Timestamps are ISO 8601 strings. Adapters don't need to understand record contents beyond
their keys.

## Conformance suite

`antiflow/testing` exports a conformance suite. It works with any test runner whose
`describe` and `test` have the usual shape (Bun, Vitest, Jest):

```ts
import { describe, test } from "vitest";
import { defineStorageAdapterTests } from "antiflow/testing";

defineStorageAdapterTests("postgres adapter", async () => createPostgresAdapter(await freshDatabase()), {
  describe,
  test,
});
```

Each test gets a fresh adapter from the factory, so the factory should return an empty
store. The suite checks the rules above for both run records and node records. It asserts
on its own and throws on failure, so it doesn't depend on any assertion library.
