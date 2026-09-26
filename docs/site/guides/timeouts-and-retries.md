---
title: Timeouts and retries
description: Per-node timeouts, retry policies, backoff strategies and how they show up in records and events.
---

# Timeouts and retries

Timeouts and retries are set **per node** in the workflow definition. Both are optional. By
default a node has no timeout and gets a single attempt.

```ts
{
  id: "charge",
  type: "payments.charge@1",
  config: { amount: 4200 },
  timeoutMs: 10_000,
  retry: { maxAttempts: 4, backoff: "exponential", delayMs: 500 },
}
```

## Timeouts

`timeoutMs` (a positive number) bounds how long **one attempt** may run. When it passes:

1. The attempt's `context.signal` aborts, with a `TimeoutError` as its reason.
2. The attempt fails **immediately** with the error `Attempt timed out after <timeoutMs>ms`.
   The engine doesn't wait for a handler that ignores its signal.
3. The failure counts against the retry policy like any thrown error.

A handler that ignores the signal keeps running in the background and keeps its concurrency
slot until it settles. Its eventual result is discarded. Always
[honour the signal](writing-node-types.md#honour-the-signal).

## Retry policy

```ts
retry: {
  maxAttempts: number;        // total attempts, including the first; an integer ≥ 1
  backoff?: "fixed" | "exponential" | ((attempt: number) => number); // default "fixed"
  delayMs?: number;           // base delay in ms, ≥ 0; default 1000
}
```

A failed attempt, whether it threw, returned an invalid result or timed out, is retried until
`maxAttempts` is reached. Each retry **re-invokes the handler from scratch with the same
input**. Nothing from the failed attempt carries over, except that `context.attempt` goes up
by one.

### Backoff

The wait before the next attempt, after attempt `n` failed:

| `backoff`       | Delay                      | With `delayMs: 500`          |
| --------------- | -------------------------- | ---------------------------- |
| `"fixed"`       | `delayMs`                  | 500, 500, 500, …             |
| `"exponential"` | `delayMs * 2^(n-1)`        | 500, 1000, 2000, 4000, …     |
| a function      | `backoff(n)`               | whatever it returns          |

A custom function receives the number of the attempt that just failed and returns a delay in
milliseconds. If it returns anything but a non-negative finite number, the node fails with an
error saying so.

```ts
retry: {
  maxAttempts: 5,
  // Exponential with jitter, capped at 30s
  backoff: (attempt) => Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2),
}
```

Custom functions only work for workflow definitions built in code. They aren't JSON.

### During a retry

- The node record stays **`running`**. Its `attempt` is the attempt that failed and its
  `error` is that attempt's error, until the next attempt starts.
- `node:start` is emitted for **every** attempt, with its `attempt` number.
- `node:failed` is emitted **once**, when the last attempt fails. A node that eventually
  succeeds emits `node:succeeded` and its record's `error` is cleared.
- A backoff doesn't hold a concurrency slot. The next attempt waits for a fresh one.
- A [cancel](cancellation.md) during a backoff ends it early, and the node becomes `cancelled`
  without another attempt.

## Custom backoff and resume

A backoff function can't be serialized, so it isn't in the persisted
[snapshot](../concepts/workflows.md#snapshots). The live run keeps using it. But if the run is
later [resumed from storage](persistence-and-resume.md), that node falls back to the default
backoff (`"fixed"` with its `delayMs`). Prefer `"fixed"` or `"exponential"` for workflows you
expect to resume.

## Validation

`execute()` rejects a workflow with an `invalid-timeout` issue if `timeoutMs` isn't a positive
finite number. It reports an `invalid-retry-policy` issue if `maxAttempts` isn't an integer
≥ 1, `backoff` isn't `"fixed"`, `"exponential"` or a function, or `delayMs` isn't a
non-negative finite number.
