---
title: Persistence and resume
description: What antiflow persists, reading run state, and resuming interrupted or failed runs.
---

# Persistence and resume

Every run's state is persisted through the engine's **storage adapter** as it runs. That lets
you inspect runs after the fact, survive a process restart, and retry failed nodes without
rerunning the whole workflow.

## Choosing storage

```ts
import { createEngine, createInMemoryStorage } from "antiflow";

const engine = createEngine({ storage: createInMemoryStorage() });
```

`createInMemoryStorage()` is the only adapter that ships with antiflow, and the default if you
pass none. It's ideal for tests and prototypes, but everything is lost when the process exits.
For durability, pass an adapter backed by your database. See
[Writing a storage adapter](storage-adapters.md).

## What's persisted

**One run record per run:**

```ts
{
  id: "6f1c…",
  status: "failed",                  // running | cancelling | cancelled | completed | failed
  startedAt: "2026-09-26T10:00:00.000Z",
  completedAt: "2026-09-26T10:00:03.412Z", // once the run ended
  workflowSnapshot: { nodes: [/* … */], edges: [/* … */] },
  input: { orderId: 42 },            // the trigger input
}
```

**One node record per node of the run:**

```ts
{
  runId: "6f1c…",
  nodeId: "charge",
  status: "failed",   // pending | running | succeeded | failed | skipped | cancelled
  attempt: 3,         // the latest attempt; 0 if it never started
  output: …,          // a single-output node's result
  outputsByPort: { … }, // or a multi-port node's result: only the fired ports
  error: "POST https://… failed with 503",
  startedAt: "…",
  completedAt: "…",
}
```

Read them with the adapter:

```ts
const run = await storage.getRun(runId);
const nodes = await storage.listNodeRecords(runId);
```

The storage adapter is the **durable source of truth**.
[Live events](events-and-logging.md) are for observers attached while the run executes. A UI
that opens a run later, or after a restart, should read state from storage.

Records never contain resolved [credentials](credentials.md). Config keeps its
`{ credentialId }` references, and outputs, errors and logs are redacted.

## Resuming a run

```ts
const handle = await engine.resume(runId);
const record = await handle.finished;
```

`resume()` continues a run from its persisted state, **against its original snapshot**, never
the current version of the workflow:

- Nodes recorded as **`succeeded`** or **`skipped`** keep their results and don't run again.
- **Every other node** (failed, interrupted mid-run, pending, halted behind a failure) runs
  again with a fresh set of attempts, starting at attempt 1.
- The run is marked `running` again, its `completedAt` is cleared, and it continues as usual,
  emitting events and ending `completed`, `failed` or `cancelled`.

### When to resume

- **After a crash or restart.** Runs whose engine died are left `running` in storage. Once you
  know that engine is gone, resume them from a new one.
- **To retry failed nodes.** A `failed` run can be resumed, for example after fixing a
  credential or when an outage is over. Only the failed nodes and what's downstream of them
  run again.

```ts
// On startup, pick up runs this process was driving when it died.
// `myRunIndex` is your own bookkeeping: antiflow doesn't list runs (see below).
for (const runId of await myRunIndex.runsOwnedBy(processId, { status: "running" })) {
  await engine.resume(runId);
}
```

antiflow's storage interface has no "list runs" query, so keeping an index of runs (per
process, per workflow, per tenant) is up to your adapter or application.

### When resume refuses

`resume()` rejects with a `ResumeError` whose `reason` says why:

| `reason`                  | When                                                                  |
| ------------------------- | --------------------------------------------------------------------- |
| `not-found`               | No run record with this id.                                           |
| `not-resumable`           | The run is `completed`, `cancelling` or `cancelled`.                   |
| `already-running`         | This engine is already running (or resuming) the run.                 |
| `unregistered-node-types` | A node type id in the snapshot isn't registered. `error.unregistered` lists each `{ nodeId, type }`. |

```ts
import { ResumeError } from "antiflow";

try {
  await engine.resume(runId);
} catch (error) {
  if (error instanceof ResumeError && error.reason === "unregistered-node-types") {
    console.error("Register these node types first:", error.unregistered);
  }
}
```

The version check is what makes upgrades safe. If you ship `http.get@2` and remove `@1`,
resuming a run that used `@1` fails loudly instead of running new code against old
assumptions. Keep old versions registered until no unfinished run needs them.

A run left **`cancelling`** by a crashed engine can't be resumed. Call `engine.cancel(runId)`
to finalize it as `cancelled`.

### Rules for hosts

- **One engine per run.** The library can't tell whether another process is still driving a
  run. Resume a `running` run only once you know its engine is gone.
- **At-least-once.** A node whose handler finished just before the crash, but whose result
  wasn't stored yet, runs again on resume. Handlers must be
  [retry-safe](writing-node-types.md#write-retry-safe-handlers).
- **Custom backoff functions aren't persisted.** Resumed nodes that had one use the default
  backoff.
