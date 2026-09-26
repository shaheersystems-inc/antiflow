---
title: Cancellation
description: Cancel a run, what happens to in-flight and waiting nodes, and how cancelled runs are recorded.
---

# Cancellation

```ts
const run = await engine.execute(workflow, input);

await engine.cancel(run.id); // resolves once the run is recorded as "cancelling"
const record = await run.finished; // status: "cancelled"
```

Cancellation is **cooperative**. antiflow never force-kills a handler. It stops starting new
work, signals the work in flight, and waits for that work to drain.

## What happens

When you call `engine.cancel(runId)`:

1. The run is saved as **`cancelling`**, and `cancel()` resolves.
2. **No new node starts.** Nodes waiting for their inputs, or for a concurrency slot, never
   start. A node in a retry backoff stops without another attempt.
3. **In-flight attempts are signalled.** Their `context.signal` aborts, with a
   `Run cancelled` error as its reason.
4. Once every in-flight attempt has settled, the run is saved as **`cancelled`**,
   `run:cancelled` is emitted and `run.finished` resolves.

How long step 4 takes depends on your handlers: one that
[honours its signal](writing-node-types.md#honour-the-signal) stops almost at once.

## How nodes are recorded

| Node was…                                    | Ends as                                                    |
| -------------------------------------------- | ---------------------------------------------------------- |
| already finished                             | unchanged (`succeeded`, `failed` or `skipped`)             |
| in flight, and the attempt still succeeded   | `succeeded`: the work was done, so its result is kept      |
| in flight, and the attempt ended in an error | `cancelled`, keeping the error (most likely the abort)     |
| in a retry backoff                           | `cancelled`                                                |
| never started                                | `cancelled`                                                |

**No `node:*` events are emitted for cancelled nodes.** `run:cancelled` tells an attached UI
that every node not yet in a final state was cancelled. The storage adapter holds the details.

## Edge cases

- **Cancelling a run that already ended** does nothing.
- **Cancelling twice** is safe. The second call waits for the same `cancelling` write.
- **A cancel that arrives while the run is being finalized**, after in-flight work has already
  drained, has no effect. The run ends as it would have anyway.
- **A run this engine isn't running.** `cancel()` rejects if the run is `running` in storage
  but not in this engine, and also for an unknown run id.
- **A run left `cancelling` by a crashed engine.** Calling `cancel()` on it from any engine
  finalizes it: every `pending` or `running` node becomes `cancelled`, then the run.
- **Cancelled runs can't be resumed.**

## Cancellation-aware handlers

`core.delay@1` is a good model. It waits with a timer, but rejects as soon as its signal
aborts:

```ts
handler: async (input, config, { signal }) => {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, config.ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
  return input.in;
},
```

For I/O, pass `signal` to `fetch`, database drivers and SDKs that accept one.
