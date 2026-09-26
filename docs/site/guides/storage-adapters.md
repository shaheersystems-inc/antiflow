---
title: Writing a storage adapter
description: The storage adapter interface, the rules an adapter must follow, and the conformance suite that checks them.
---

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
   stands alone, which is why antiflow's execution guarantee is
   [at-least-once](../concepts/execution.md#at-least-once-execution).
3. **JSON in, the same JSON out.** Records hold only JSON values (strings, numbers,
   booleans, null, arrays, plain objects). They must read back structurally equal. Storing
   them as a JSON column is fine. Dropping properties whose value is `undefined` is fine too.
4. **No shared references.** Mutating an object after passing it to a save, or after
   reading it back, must not change what's stored. Adapters that serialize get this for
   free.
5. **Keep runs apart.** Records of one run are never returned for another.
6. **Concurrent saves are all kept.** The engine saves several node records of one run at
   once. An adapter that stores a run's node records together, for example in a single
   blob, must not lose any of them to a read-modify-write race.
7. **Keys are exact.** A node record's key is the pair (`runId`, `nodeId`). Keys built by
   joining the two, such as `` `${runId}:${nodeId}` ``, can collide. Store the pair
   separately, or escape it.

`getRun` returns `undefined`, not `null`, for a run that was never saved. Timestamps are ISO
8601 strings. Treat them as opaque strings that come back exactly as saved: a `timestamptz`
column that reformats them won't do. Adapters don't need to understand record contents
beyond their keys.

## Example: Postgres

A sketch of an adapter over [node-postgres](https://node-postgres.com), storing each record
as a `jsonb` document next to its key columns:

```sql
create table antiflow_runs (
  id     text primary key,
  record jsonb not null
);

create table antiflow_node_records (
  run_id  text not null,
  node_id text not null,
  record  jsonb not null,
  primary key (run_id, node_id)
);
```

```ts
import type { StorageAdapter } from "antiflow";
import type { Pool } from "pg";

export function createPostgresAdapter(pool: Pool): StorageAdapter {
  return {
    async saveRun(run) {
      await pool.query(
        `insert into antiflow_runs (id, record) values ($1, $2)
         on conflict (id) do update set record = excluded.record`,
        [run.id, JSON.stringify(run)],
      );
    },
    async getRun(runId) {
      const { rows } = await pool.query("select record from antiflow_runs where id = $1", [runId]);
      return rows[0]?.record; // undefined when there's no row
    },
    async saveNodeRecord(record) {
      await pool.query(
        `insert into antiflow_node_records (run_id, node_id, record) values ($1, $2, $3)
         on conflict (run_id, node_id) do update set record = excluded.record`,
        [record.runId, record.nodeId, JSON.stringify(record)],
      );
    },
    async listNodeRecords(runId) {
      const { rows } = await pool.query("select record from antiflow_node_records where run_id = $1", [runId]);
      return rows.map((row) => row.record);
    },
  };
}
```

This follows the rules: upserts replace the whole document (1), each statement stands alone
(2), `jsonb` round-trips JSON and keeps timestamps as the strings they were saved as (3), rows
are parsed into fresh objects on every read (4), and the key is a real composite key (5–7).

Add your own columns (tenant, workflow id, status, `startedAt`) if you need to query runs, for
example to find `running` runs to [resume](persistence-and-resume.md) after a restart. The
engine only ever calls the four methods above.

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
on its own and throws on failure, so it doesn't depend on any assertion library. See
[`antiflow/testing`](../reference/testing.md) for the full list of checks.
