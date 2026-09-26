---
title: Testing
description: Test handlers, workflows and storage adapters.
---

# Testing

## Testing handlers

A handler is a plain async function. Call it directly with an input, a config and a fake
context:

```ts
import { expect, test } from "vitest";
import type { NodeContext } from "antiflow";
import { validate } from "./validate-email.ts";

const context = (overrides: Partial<NodeContext> = {}): NodeContext => ({
  runId: "run-1",
  nodeId: "node-1",
  attempt: 1,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  signal: new AbortController().signal,
  credentials: {},
  ...overrides,
});

test("fires invalid for an address without @", async () => {
  const config = validate.config.parse({}); // apply defaults, as the engine does
  expect(await validate.handler({ in: { email: "nope" } }, config, context())).toEqual({
    invalid: { email: "nope" },
  });
});
```

## Testing workflows

For anything that involves more than one node, such as branching, skips, retries or
cancellation, run a real engine over in-memory storage. It's fast and needs no
infrastructure:

```ts
import { expect, test } from "vitest";
import { createEngine, createInMemoryStorage } from "antiflow";
import type { EngineEvent, JsonValue, WorkflowDefinition } from "antiflow";
import { registerCoreNodes } from "antiflow/nodes/core";
import { registerAppNodes } from "../src/nodes.ts";

async function runWorkflow(workflow: WorkflowDefinition, input: JsonValue) {
  const storage = createInMemoryStorage();
  const engine = createEngine({ storage });
  registerCoreNodes(engine);
  registerAppNodes(engine);
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));

  const handle = await engine.execute(workflow, input);
  const run = await handle.finished;
  const nodes = Object.fromEntries((await storage.listNodeRecords(handle.id)).map((r) => [r.nodeId, r]));
  return { run, nodes, events };
}

test("routes large orders to review", async () => {
  const { run, nodes } = await runWorkflow(orderWorkflow, { total: 500 });
  expect(run.status).toBe("completed");
  expect(nodes.review?.status).toBe("succeeded");
  expect(nodes.autoApprove?.status).toBe("skipped");
});
```

Tips:

- **Assert on records and events**, not on the order of internal calls. That's what antiflow's
  own test suite does.
- **Fake node types are cheap.** Define tiny ones inline in tests: one that echoes its input,
  one that fails _n_ times then succeeds, one that waits until its signal aborts, one that
  fires a chosen port.
- **Keep time short.** Use `delayMs: 0` or a custom `backoff: () => 0` in retry policies, and
  small `timeoutMs` values. antiflow has no fake clock.

## Testing a storage adapter

Run the conformance suite from `antiflow/testing` against your adapter, in any test runner
whose `describe` and `test` have the usual shape (Bun, Vitest, Jest):

```ts
import { describe, test } from "vitest";
import { defineStorageAdapterTests } from "antiflow/testing";
import { createPostgresAdapter } from "../src/postgres-adapter.ts";

defineStorageAdapterTests(
  "postgres adapter",
  async () => createPostgresAdapter(await freshDatabase()), // an empty store per test
  { describe, test },
);
```

See [`antiflow/testing`](../reference/testing.md) for what it checks, and
[Writing a storage adapter](storage-adapters.md) for the rules behind it.
