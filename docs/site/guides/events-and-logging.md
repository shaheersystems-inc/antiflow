---
title: Events and logging
description: Subscribe to live run events and route node logs to your own logger.
---

# Events and logging

## Live events

`engine.subscribe()` registers a listener for events from **every run** of the engine. It
returns a function that unsubscribes.

```ts
const unsubscribe = engine.subscribe((event) => {
  switch (event.type) {
    case "node:start":
      canvas.markRunning(event.runId, event.nodeId, event.attempt);
      break;
    case "node:failed":
      canvas.markFailed(event.runId, event.nodeId, event.error);
      break;
    case "run:completed":
    case "run:failed":
    case "run:cancelled":
      canvas.finish(event.runId, event.type);
      break;
  }
});
```

| Event            | Fields                                  | Emitted when                                                  |
| ---------------- | --------------------------------------- | ------------------------------------------------------------- |
| `node:start`     | `runId`, `nodeId`, `attempt`            | An attempt starts. Once per attempt, so again on each retry. |
| `node:succeeded` | `runId`, `nodeId`, `attempt`            | The node succeeded. Its result is already persisted.          |
| `node:failed`    | `runId`, `nodeId`, `attempt`, `error`   | The node failed for good, after its last attempt.            |
| `node:skipped`   | `runId`, `nodeId`                       | The node was skipped.                                         |
| `run:completed`  | `runId`                                 | Every node succeeded or was skipped.                          |
| `run:failed`     | `runId`                                 | The run ended with at least one failed node.                  |
| `run:cancelled`  | `runId`                                 | A cancelled run has drained. Nodes not yet final were cancelled. |

Things to know:

- **Filter by `runId`.** One listener sees every run of the engine.
- **Events carry no outputs.** Read results from storage. `node:succeeded` fires after the
  node record is saved, so a read triggered by the event sees the result.
- **Errors in events are redacted** of resolved credentials, like everything else.
- **Cancelled nodes get no event.** `run:cancelled` stands for all of them.
- **Listeners are called synchronously.** Keep them fast, and don't throw from them: hand
  heavy work, such as pushing to a WebSocket, off to a queue.
- **Events are not durable.** A process that wasn't subscribed, or restarted, reads state from
  the [storage adapter](persistence-and-resume.md#whats-persisted) instead.

### Streaming a run to a UI

A typical pattern: send the current records when a client connects, then forward live events
for that run.

```ts
async function watchRun(runId: string, send: (message: unknown) => void) {
  const unsubscribe = engine.subscribe((event) => {
    if (event.runId !== runId) return;
    send(event);
    if (event.type.startsWith("run:")) unsubscribe();
  });
  // Subscribe first, then read, so nothing is missed in between.
  send({ type: "snapshot", run: await storage.getRun(runId), nodes: await storage.listNodeRecords(runId) });
  return unsubscribe;
}
```

## Logging

Handlers log through `context.logger`. The engine forwards every entry to the logger you pass
to `createEngine`, with `runId`, `nodeId` and `attempt` added to its fields:

```ts
const engine = createEngine({
  logger: {
    debug: (message, fields) => console.debug(message, fields),
    info: (message, fields) => console.info(message, fields),
    warn: (message, fields) => console.warn(message, fields),
    error: (message, fields) => console.error(message, fields),
  },
});

// In a handler
context.logger.info("charging card", { amount: 4200 });
// → info("charging card", { runId: "6f1c…", nodeId: "charge", attempt: 1, amount: 4200 })
```

Without a `logger` option, node logs are discarded.

The `Logger` interface has four methods, each `(message: string, fields?: Record<string,
unknown>) => void`. It maps directly onto pino, winston, bunyan or `console`. For example,
with pino:

```ts
import pino from "pino";
const log = pino();

const engine = createEngine({
  logger: {
    debug: (msg, fields) => log.debug(fields ?? {}, msg),
    info: (msg, fields) => log.info(fields ?? {}, msg),
    warn: (msg, fields) => log.warn(fields ?? {}, msg),
    error: (msg, fields) => log.error(fields ?? {}, msg),
  },
});
```

Resolved credentials are **redacted** from log messages and fields before they reach your
logger. See [Credentials](credentials.md#redaction).
