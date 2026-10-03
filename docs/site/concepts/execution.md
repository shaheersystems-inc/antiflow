---
title: Runs and execution
description: "How a run executes: concurrency, skip propagation, failure isolation, statuses and the at-least-once guarantee."
---

# Runs and execution

A **run** is one execution of a workflow, started by `engine.execute(workflow, triggerInput)`.
This page explains how the engine moves a run from start to finish.

## Lifecycle of a run

1. **Validate.** The workflow is checked against the registered node types. An invalid
   workflow is rejected and nothing is saved.
2. **Snapshot.** The workflow is deep-copied and frozen. The run executes only against this
   [snapshot](workflows.md#snapshots).
3. **Record.** A run record with status `running` is saved, then a `pending` node record for
   every node.
4. **Execute.** The engine repeatedly works out which nodes are _ready_ (all their inputs
   resolved) and which will _never_ run (skipped). It starts every ready node, and each time a
   node settles, it looks again.
5. **Finish.** When nothing more can run, the run ends `completed`, `failed` or `cancelled`,
   and the matching `run:*` event is emitted.

`execute()` resolves after step 3 with a `RunHandle`:

```ts
const run = await engine.execute(workflow, triggerInput);
run.id; // the run id
const record = await run.finished; // the final run record
```

## Concurrency

Every node whose inputs are ready runs **at the same time**, not one after another. Most nodes
spend their time waiting on I/O, so parallel branches finish as soon as their slowest node.

Handlers run in-process, as async functions on the engine's event loop. To bound how much
runs at once, set caps on the engine (never in workflow JSON):

```ts
const engine = createEngine({
  concurrency: {
    global: 20, // at most 20 handlers at once, across every run of this engine
    perNodeType: {
      "http.get@1": 5, // at most 5 HTTP calls at once
      "openai.chat@1": 2,
    },
  },
});
```

- Caps count running handler attempts across **all runs** of the engine.
- `perNodeType` is keyed by node type id (`type@version`).
- A node waiting for its node type's slot doesn't block other node types queued behind it.
- A retry waits for a fresh slot. A node doesn't hold a slot during its backoff.
- A handler that ignores a timeout or cancel keeps its slot until it really settles, so the
  caps stay true.
- Caps must be positive integers. Leave one unset for no limit.

## Branching and skips

A node type with several output ports fires only some of them on each run. For example, an
If node fires either `true` or `false`. What happens downstream depends on whether a node's
inputs **resolve**:

- An input **resolves** when its upstream node succeeded and fired the edge's port.
- An input will **never resolve** when its upstream node was skipped, or succeeded without
  firing that port.

A node is marked **`skipped`**, meaning it never ran and didn't fail, when:

- a **required** input will never resolve, or
- **none** of its wired inputs will ever resolve, even if they're all optional.

Skips propagate: everything downstream of a skipped node is skipped too, all the way down the
untaken branch. A skip isn't a failure. A run whose nodes all succeeded or were skipped is
`completed`.

An **optional** input port that never resolves is simply left out of the node's input. This
is how the core Merge node rejoins the branches of an If or Switch. See
[Branching and merging](../guides/branching-and-merging.md).

## Failures stay on their branch

When a handler throws, returns an invalid result or times out, and has no retries left, its
node is marked `failed` with the error message. Then:

- Nodes **downstream** of the failed node don't run. They keep their `pending` node records
  and are _halted_, not skipped, because they could still run if the failed node is retried
  later.
- **Independent branches keep running** to completion.
- Once everything runnable has finished, the run ends `failed` and `run:failed` is emitted.

A failed run can be [resumed](../guides/persistence-and-resume.md). Resume reruns the failed
nodes, then their halted downstream nodes, without rerunning nodes that already succeeded.

## Statuses

### Run status

| Status       | Meaning                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| `running`    | The run is executing, or its engine stopped mid-run (resumable).                 |
| `cancelling` | `cancel()` was called. No new nodes start while in-flight attempts drain.        |
| `cancelled`  | Cancelled, and all in-flight work has settled. Final.                             |
| `completed`  | Every node `succeeded` or was `skipped`. Final.                                   |
| `failed`     | At least one node `failed`, after every independent branch drained. Resumable.   |

### Node status

| Status      | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `pending`   | Not started yet: waiting on inputs, waiting for a slot, or halted behind a failure. |
| `running`   | An attempt is in progress, or the node is in a retry backoff.                    |
| `succeeded` | The handler returned a valid result, stored as `output` or `outputsByPort`.      |
| `failed`    | The last attempt failed. `error` holds the message.                              |
| `skipped`   | Never ran, because its inputs will never resolve.                                |
| `cancelled` | The run was cancelled before the node finished (or started).                     |

## At-least-once execution

antiflow runs every handler **at least once, not exactly once**. A handler may run more than
once for the same node of the same run:

- A **retry** re-invokes it from scratch, with the same input, after a failed or timed-out
  attempt.
- A **resume** reruns every node that hadn't persisted a `succeeded` result. That includes a
  node whose handler finished just before the process died, before its result was stored.
- A **timeout** or **cancel** only aborts the handler's `signal`. A handler that ignores the
  signal keeps running even though its attempt has already ended.

Exactly-once would require every storage adapter to support transactions that commit a
handler's side effects and its result together. antiflow deliberately keeps adapters simple
instead. So **write handlers to be retry-safe**:

- Make side effects idempotent, for example by sending an idempotency key derived from
  `context.runId` and `context.nodeId` to the APIs you call.
- Honour `context.signal`: pass it to `fetch` and other abortable APIs, and stop early when it
  aborts.

## One engine per run

Only one engine may drive a given run at a time. The library can't detect that a run is still
live in another process, so only [resume](../guides/persistence-and-resume.md) a `running` run
once you know the engine that was running it is gone.
