# Testing with antiflow

## Contents

- [Handlers](#handlers)
- [Workflows](#workflows)
- [Fake node types](#fake-node-types)
- [Storage adapter conformance](#storage-adapter-conformance)

## Handlers

A handler is a plain async function. Call it directly with a fake context. Parse the config
through the schema first, as the engine does, so defaults apply.

```ts
import { expect, test } from "vitest"; // or bun:test, jest
import type { NodeContext } from "antiflow";
import { validateEmail } from "./nodes.ts";

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
  const config = validateEmail.config.parse({});
  expect(await validateEmail.handler({ in: { email: "nope" } }, config, context())).toEqual({
    invalid: { email: "nope" },
  });
});
```

To test abort handling, pass an aborted signal: `const c = new AbortController(); c.abort();
context({ signal: c.signal })`. To test credentials, pass
`credentials: { "slack-acme": "xoxb-test" }`.

## Workflows

For anything involving several nodes (branching, skips, retries, cancellation), run a real
engine over in-memory storage. It's fast and needs no infrastructure.

```ts
import { createEngine, createInMemoryStorage } from "antiflow";
import type { EngineEvent, JsonValue, WorkflowDefinition } from "antiflow";
import { registerCoreNodes } from "antiflow/nodes/core";

async function runWorkflow(workflow: WorkflowDefinition, input: JsonValue) {
  const storage = createInMemoryStorage();
  const engine = createEngine({ storage });
  registerCoreNodes(engine);
  registerAppNodes(engine); // your node types
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

- Assert on **records and events**, not on the order of internal calls.
- To check validation, `await expect(engine.execute(bad, null)).rejects.toThrow(WorkflowValidationError)`,
  then inspect `error.issues` codes.
- Keep time short: `retry: { maxAttempts: 3, delayMs: 0 }` or `backoff: () => 0`, and
  small `timeoutMs`. There's no fake clock.
- To test cancel: start a run whose node waits on its signal, `await engine.cancel(run.id)`,
  then expect `(await run.finished).status` to be `"cancelled"`.
- To test resume: run until `failed`, fix the cause (for example a fake that now succeeds),
  then `await (await engine.resume(run.id)).finished` and check that earlier `succeeded` nodes
  weren't re-invoked.

## Fake node types

Define tiny node types inline in tests:

```ts
import { defineNodeType } from "antiflow";
import type { JsonValue } from "antiflow";
import { z } from "zod";

const start = defineNodeType({
  type: "test.start", version: 1, inputs: [], outputs: ["out"],
  config: z.object({}), display: { name: "Start" },
  handler: async (input) => input,
});

const echo = defineNodeType({
  type: "test.echo", version: 1, inputs: ["in"], outputs: ["out"],
  config: z.object({}), display: { name: "Echo" },
  handler: async (input) => input.in,
});

let calls = 0;
const flaky = defineNodeType({ // fails `failTimes` times, then succeeds
  type: "test.flaky", version: 1, inputs: ["in"], outputs: ["out"],
  config: z.object({ failTimes: z.number() }), display: { name: "Flaky" },
  handler: async (input, config) => {
    if (++calls <= config.failTimes) throw new Error(`fail ${calls}`);
    return input.in;
  },
});

const waitForAbort = defineNodeType({ // never finishes until cancelled or timed out
  type: "test.wait", version: 1, inputs: ["in"], outputs: ["out"],
  config: z.object({}), display: { name: "Wait" },
  handler: (_input, _config, { signal }) =>
    new Promise<JsonValue>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
});
```

## Storage adapter conformance

```ts
import { describe, test } from "vitest"; // bun:test and jest fit too
import { defineStorageAdapterTests } from "antiflow/testing";

defineStorageAdapterTests(
  "postgres adapter",
  async () => createPostgresAdapter(await freshDatabase()), // an EMPTY store per test
  { describe, test },
);
```

The suite asserts on its own (no assertion library needed). It checks: unknown run returns
`undefined`; records read back unchanged; saves replace whole records; runs are kept apart;
mutation after save or read doesn't leak; many concurrent node saves are all kept; ids that
run together (`r1` + `a:b` vs `r1:a` + `b`) aren't confused; and every JSON value
round-trips.
