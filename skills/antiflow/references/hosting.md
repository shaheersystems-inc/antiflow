# Hosting the engine

## Contents

- [Install](#install)
- [createEngine](#createengine)
- [Running workflows](#running-workflows)
- [Reading state](#reading-state)
- [Live events](#live-events)
- [Logging](#logging)
- [Cancel](#cancel)
- [Resume](#resume)
- [Storage adapters](#storage-adapters)
- [Credential stores](#credential-stores)
- [Triggers](#triggers)
- [Building a UI](#building-a-ui)
- [Guarantees and limits](#guarantees-and-limits)

## Install

```bash
npm install antiflow zod
```

antiflow needs Zod 4 (node type config schemas) and any modern runtime: Node 20+, Bun, Deno
or edge runtimes. It uses only web platform APIs. While it's in beta, the npm version may be
under the `beta` tag (`npm install antiflow@beta zod`).

Entry points: `antiflow` (engine, types, errors, `defineNodeType`, `credentialRef`,
`createInMemoryStorage`), `antiflow/nodes/core` (core nodes), `antiflow/testing` (adapter
conformance suite).

## createEngine

```ts
import { createEngine, createInMemoryStorage } from "antiflow";
import { registerCoreNodes } from "antiflow/nodes/core";

const storage = createInMemoryStorage(); // the default; lost on exit
const engine = createEngine({
  storage, // StorageAdapter
  logger, // Logger; node logs are discarded without one
  credentials, // CredentialStore; needed only if config uses credentialRef
  concurrency: { global: 20, perNodeType: { "http.get@1": 5 } }, // positive integers
});
registerCoreNodes(engine);
engine.register(myNodeType);
```

- Create **one engine per process** and register every node type at startup, so registration
  errors surface immediately.
- Concurrency caps count running handler attempts across **all runs** of that engine, and are
  keyed by node type id. Caps never go in workflow JSON. A backoff doesn't hold a slot. A
  handler that ignores its signal holds its slot until it settles. Caps don't span several
  engines or processes.
- Type helpers: `Engine`, `EngineOptions`, `ConcurrencyOptions`.

## Running workflows

```ts
const run = await engine.execute(workflow, triggerInput); // resolves once started
const record = await run.finished; // RunRecord: completed | failed | cancelled
```

- `execute()` validates, takes an immutable snapshot (later edits to `workflow` don't affect
  the run), saves a `running` run record and `pending` node records, then starts the run.
- An invalid workflow rejects with `WorkflowValidationError`. Nothing runs and nothing is
  saved.
- `run.finished` resolves with the final run record. It doesn't contain node outputs, so read
  those from storage.

## Reading state

```ts
const runRecord = await storage.getRun(runId); // undefined if unknown
const nodes = await storage.listNodeRecords(runId);
const byId = Object.fromEntries(nodes.map((n) => [n.nodeId, n]));
byId.notify?.output; // single-output result
byId.check?.outputsByPort; // multi-port result: fired ports only
```

Run record: `{ id, status, startedAt, completedAt?, workflowSnapshot, input }`. Node record:
`{ runId, nodeId, status, attempt, output?, outputsByPort?, error?, startedAt?, completedAt? }`.

| Run status | Meaning |
| ---------- | ------- |
| `running` | Executing, or its engine died mid-run (resumable). |
| `cancelling` | `cancel()` called. In-flight work is draining. |
| `cancelled` | Final. |
| `completed` | Every node succeeded or was skipped. Final. |
| `failed` | At least one node failed, after independent branches drained. Resumable. |

Node statuses: `pending` (waiting, or halted behind a failure), `running` (an attempt or
backoff in progress), `succeeded`, `failed`, `skipped`, `cancelled`.

antiflow has **no "list runs" query**. Keep your own index of run ids (per workflow, tenant or
process) when you start runs.

## Live events

```ts
const unsubscribe = engine.subscribe((event) => {
  if (event.runId !== runId) return; // one listener sees every run
  // event.type: node:start | node:succeeded | node:failed | node:skipped
  //             run:completed | run:failed | run:cancelled
});
```

- `node:start` fires once per attempt (again on each retry). `node:failed` fires once, after
  the last attempt, and carries `error`. `node:succeeded` fires after the result is persisted.
- Events carry **no outputs**. Read them from storage.
- Cancelled nodes get **no** node event. `run:cancelled` stands for all of them.
- Listeners are called synchronously. Keep them fast and never throw. Hand heavy work (a
  WebSocket push) to a queue.
- Events aren't durable. To stream a run to a client, **subscribe first, then read** the
  current records from storage, so nothing is missed between the two.

## Logging

```ts
createEngine({
  logger: {
    debug: (msg, fields) => log.debug(fields ?? {}, msg), // e.g. pino
    info: (msg, fields) => log.info(fields ?? {}, msg),
    warn: (msg, fields) => log.warn(fields ?? {}, msg),
    error: (msg, fields) => log.error(fields ?? {}, msg),
  },
});
```

Entries from `context.logger` arrive with `{ runId, nodeId, attempt }` added to the fields,
and with resolved secrets redacted.

## Cancel

```ts
await engine.cancel(run.id); // resolves once the run is recorded "cancelling"
await run.finished; // status "cancelled" once in-flight attempts settle
```

- No new node starts. In-flight attempts see their signal abort. Nodes in a backoff stop.
- In-flight attempts that still succeed keep `succeeded`. Everything else not final becomes
  `cancelled`.
- A no-op for a run that already ended, and safe to call twice. It rejects for an unknown run,
  or a `running` run this engine isn't running.
- A run left `cancelling` by a crashed engine: call `cancel()` from any engine to finalize
  it.
- Cancelled runs can't be resumed. Cancellation is cooperative, so handlers must honour
  `signal`.

## Resume

```ts
import { ResumeError } from "antiflow";

try {
  const handle = await engine.resume(runId);
  await handle.finished;
} catch (error) {
  if (error instanceof ResumeError && error.reason === "unregistered-node-types") {
    console.error("Register first:", error.unregistered); // [{ nodeId, type }]
  } else throw error;
}
```

- Works on `running` (interrupted) and `failed` runs, always against the run's **snapshot**.
- `succeeded` and `skipped` nodes keep their results. Every other node re-runs from attempt 1.
- `reason`: `not-found`, `not-resumable` (completed, cancelling or cancelled),
  `already-running` (this engine is running it), `unregistered-node-types`.
- **One engine per run**: resume a `running` run only once you know the engine that was
  driving it is gone. The library can't detect a live engine in another process.
- On startup, resume the runs your own index says this process owned and that are still
  `running`.
- Nodes interrupted mid-handler re-run (at-least-once), so handlers must be idempotent.

## Storage adapters

```ts
interface StorageAdapter {
  saveRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  saveNodeRecord(record: NodeRecord): Promise<void>;
  listNodeRecords(runId: string): Promise<NodeRecord[]>;
}
```

Rules (checked by `defineStorageAdapterTests` from `antiflow/testing`, see
[testing.md](testing.md#storage-adapter-conformance)):

1. Saves are **whole-record upserts**, not merges. Fields missing from the new record must
   disappear.
2. No transactions are needed. Each call stands alone.
3. JSON in, structurally equal JSON out. Timestamps are opaque ISO strings and must come back
   exactly as saved (don't use a `timestamptz` column that reformats them).
4. No shared references: mutating an object after save or read must not change what's stored.
5. Keep runs apart. Node records are keyed by the **pair** (`runId`, `nodeId`). Don't use a
   joined string like `` `${runId}:${nodeId}` ``, which can collide.
6. Concurrent saves for one run must all be kept (no read-modify-write races on a shared
   blob).
7. `getRun` returns `undefined`, not `null`, for an unknown run. `listNodeRecords` returns
   `[]`.

Postgres sketch: tables `antiflow_runs(id text primary key, record jsonb)` and
`antiflow_node_records(run_id text, node_id text, record jsonb, primary key (run_id,
node_id))`, with `insert … on conflict … do update set record = excluded.record`, and reads
returning `rows[0]?.record` and `rows.map((r) => r.record)`. Add your own columns (tenant,
workflow id, status) for querying. The engine only calls the four methods.

## Credential stores

```ts
import type { CredentialStore } from "antiflow";

const credentials: CredentialStore = {
  async resolve(credentialId, { runId, nodeId }) {
    const secret = await vault.read(`workflows/${credentialId}`); // scope by tenant of runId
    if (!secret) throw new Error("not found");
    return secret; // any JSON: a string, or { user, password }
  },
};
const engine = createEngine({ credentials });
```

- Resolution happens before **each attempt**. A rejection fails the attempt with
  `Credential "<id>" could not be resolved`. The store's own message is never recorded.
- Workflows, snapshots and records hold only `{ credentialId }`. Resolved secrets are
  redacted from outputs, errors, events and logs (exact matches of string/number leaves of at
  least 4 characters).

## Triggers

antiflow has no webhook server or scheduler. Every trigger is host code ending in the same
call:

```ts
app.post("/hooks/:workflowId", async (req, res) => {
  const workflow = await loadWorkflow(req.params.workflowId);
  const run = await engine.execute(workflow, req.body); // nodes with no inputs receive req.body
  res.status(202).json({ runId: run.id });
});
```

## Building a UI

| UI feature | API |
| ---------- | --- |
| Node palette | `engine.listNodeTypes()`: `id`, `display` (`name`, `description`, `category`, `icon`), `trigger` |
| Handles | `inputs`, `optionalInputs`, `outputs` |
| Config forms | `configSchema`: JSON Schema draft 2020-12, input side (fields with defaults are optional) |
| Credential pickers | A config property that's an object with only `credentialId`, described "A reference to a credential in the host's credential store" |
| Error highlighting | `WorkflowValidationError.issues`: `edgeIndex`, `nodeId`/`nodeIds`, `configIssues[].path` |
| Run / Stop / Retry | `execute`, `cancel`, `resume` |
| Live canvas | `subscribe` plus an initial storage read |
| History | Render from the run record's `workflowSnapshot`, not the current workflow |

`listNodeTypes()` returns plain JSON (fresh copies), so you can send it to a browser. Mirror
the graph rules in the editor: output-to-input only, one edge per input port (suggest Merge),
no cycles. Store the full `id` (`type@version`) in each node's `type`, and show the newest
version in the palette.

## Guarantees and limits

- At-least-once execution, not exactly-once.
- Cancel and timeout signal handlers. They never force-kill them.
- Snapshots make runs and resumes immune to later workflow edits. Custom backoff functions
  aren't persisted.
- Resume checks node type ids, but can't detect a changed handler under the same version.
- Redaction catches exact secret values only.
- Concurrency caps are per engine. Nothing coordinates several processes, and only one engine
  may drive a run.
