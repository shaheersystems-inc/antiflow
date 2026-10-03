---
name: antiflow
description: "Build on antiflow, the embeddable JSON-declared nodes-and-edges workflow engine for TypeScript/JavaScript. Use when writing antiflow node types (defineNodeType handlers, ports, Zod config), authoring or debugging workflow definitions (nodes, edges, core.if/switch/merge/set/delay, timeouts, retries), embedding the engine in a host (createEngine, execute, events, cancel, resume, storage adapters, credential stores), building a workflow editor UI on listNodeTypes(), or testing any of these. Triggers: imports from \"antiflow\", \"antiflow/nodes/core\" or \"antiflow/testing\"; WorkflowValidationError or ResumeError; node type ids like \"core.if@1\"."
---

# antiflow

antiflow is a **library**, not a service: a nodes-and-edges workflow engine that runs inside
the host application. Workflows are plain JSON. Node types are typed, versioned handlers the
host registers. The host supplies storage and decides when runs start. There's no UI, HTTP
server, queue or scheduler.

Read the reference file for the task before writing code:

| Task | Read |
| ---- | ---- |
| Writing a node type (handler, ports, config, context, credentials in a handler) | [node-types.md](references/node-types.md) |
| Writing or fixing a workflow definition, branching, timeouts, retries, validation errors | [workflows.md](references/workflows.md) |
| Embedding the engine: execute, events, logging, concurrency, cancel, resume, storage adapters, credential stores, UIs | [hosting.md](references/hosting.md) |
| Testing handlers, workflows or a storage adapter | [testing.md](references/testing.md) |

## Mental model

- **Node type**: a registered kind of node: `type` + `version` (id `type@version`, e.g.
  `core.if@1`), named input and output ports, a Zod config schema, display metadata and an
  async handler. Registered with `engine.register()`.
- **Workflow definition**: `{ nodes, edges }`. Each node is `{ id, type: "type@version",
  config, timeoutMs?, retry? }`. Each edge joins an output port to an input port:
  `{ from: { node, port }, to: { node, port } }`. It must be a DAG.
- **Run**: one execution, `await engine.execute(workflow, triggerInput)`. Nodes whose node
  type has **no input ports** receive `triggerInput`. Every other node receives
  `{ [inputPort]: value }`. Everything that's ready runs concurrently.
- **Records**: the storage adapter holds one run record and one node record per node. It's
  the durable source of truth. Live events are for observers attached while the run executes.

## Quick start

```ts
import { createEngine, defineNodeType, WorkflowValidationError } from "antiflow";
import type { JsonValue, WorkflowDefinition } from "antiflow";
import { registerCoreNodes } from "antiflow/nodes/core";
import { z } from "zod";

const engine = createEngine(); // in-memory storage by default
registerCoreNodes(engine); // If, Switch, Merge, Set, Delay: never registered for you

engine.register(
  defineNodeType({
    type: "app.order", // namespace prefix, no "@"
    version: 1,
    inputs: [], // no inputs: receives the trigger input
    outputs: ["out"], // one output: return a bare value
    trigger: true, // metadata only: "a run can begin here"
    config: z.object({}),
    display: { name: "Order received", category: "Triggers" },
    handler: async (order) => order,
  }),
);

engine.register(
  defineNodeType({
    type: "app.notify",
    version: 1,
    inputs: ["in"],
    outputs: ["out"],
    config: z.object({ channel: z.string().describe("Where to post") }),
    display: { name: "Notify", category: "App" },
    handler: async (input, config, { runId, nodeId, signal, logger }): Promise<JsonValue> => {
      logger.info("notifying", { channel: config.channel });
      signal.throwIfAborted();
      return { channel: config.channel, order: input.in, key: `${runId}:${nodeId}` };
    },
  }),
);

const workflow: WorkflowDefinition = {
  nodes: [
    { id: "order", type: "app.order@1", config: {} },
    { id: "big", type: "core.if@1", config: { field: "total", operator: "greaterThan", value: 100 } },
    { id: "notify", type: "app.notify@1", config: { channel: "#sales" }, timeoutMs: 5000 },
  ],
  edges: [
    { from: { node: "order", port: "out" }, to: { node: "big", port: "in" } },
    { from: { node: "big", port: "true" }, to: { node: "notify", port: "in" } },
  ],
};

try {
  const run = await engine.execute(workflow, { id: 7, total: 250 });
  const record = await run.finished; // { status: "completed", ... }
} catch (error) {
  if (error instanceof WorkflowValidationError) console.error(error.issues); // nothing ran
  else throw error;
}
```

Read results from storage, not from events or the run handle:
`createEngine({ storage })`, then `await storage.listNodeRecords(run.id)`. Each node record
has `status`, `attempt`, `output` (single-output node) or `outputsByPort` (multi-port node),
`error` and timestamps.

## Rules that are easy to get wrong

1. **Config is static JSON.** There are no expressions or templates (`{{$json.x}}` doesn't
   exist). Per-run values flow in through **input ports**, never through config.
2. **One edge per input port.** To combine branches or values, wire them into
   `core.merge@1` (optional inputs `a`–`d`). An output port can feed any number of edges.
3. **One JSON value per edge.** There's no per-item iteration. An array is one value.
4. **No cycles, loops, sub-workflows or code nodes** in v1. Don't invent them. Model
   iteration inside a handler, or have the host call `execute()` again.
5. **Single output port means return a bare value. Several output ports means return an
   object with only the fired ports** (`{ valid: x }`). Unfired ports skip everything
   downstream. Returning a non-object, or an undeclared port, from a multi-port handler fails
   the attempt.
6. **Skipped isn't failed.** A node is skipped when a required input never resolves (an
   untaken branch), or when none of its wired inputs resolve. A run of succeeded and skipped
   nodes is `completed`. Rejoin branches through optional inputs (Merge), or a required input
   from each branch will skip the joining node.
7. **Execution is at-least-once.** Retries, resume and crashes can re-run a handler for the
   same node of the same run. Make side effects idempotent (key them on
   `` `${context.runId}:${context.nodeId}` ``) and keep no state between attempts.
8. **Timeouts and cancel don't stop code.** They abort `context.signal` and end the attempt
   at once. Pass `signal` to `fetch`/SDKs and check `signal.throwIfAborted()` between steps.
9. **Handlers return JSON only.** `null`, booleans, numbers, strings, arrays, plain objects.
   The engine doesn't deep-check this. A `Date`, `Map` or class instance may survive the
   in-memory adapter but break or change shape in a real storage adapter, so convert first
   (`date.toISOString()`). Throwing fails the attempt, and only `error.message` is kept.
10. **Versions are part of identity.** Workflows reference `type@version`. Bump `version`
    when config shape, ports or behaviour change, and keep the old version registered while
    stored workflows or unfinished runs use it. Resume refuses runs whose node type ids aren't
    registered.
11. **Secrets never go in config.** Use a `credentialRef` field (`{ credentialId }`), a host
    `CredentialStore`, and read the secret from `context.credentials[credentialId]`.
12. **Core nodes are opt-in** (`registerCoreNodes(engine)` from `antiflow/nodes/core`). None
    is trigger-capable, so every workflow starts from a host node type with `inputs: []`.
13. **The library owns no triggers.** Webhooks, cron and "Run" buttons are host code that
    calls `engine.execute(workflow, triggerInput)`. `trigger: true` is UI metadata only.

## Choosing a building block

- **Branch on a value**: `core.if@1` (`true`/`false`) or `core.switch@1` (`case1`–`case8`,
  `default`; first match wins).
- **Rejoin branches or gather parallel results**: `core.merge@1` with `mode` `array`,
  `object` or `first`.
- **A constant, or add fields to an object**: `core.set@1` (`value`, `merge: true`).
- **Wait**: `core.delay@1` (`ms`). It honours cancel and timeout.
- **Anything else** (HTTP, databases, transforms, custom branching): write a node type.
  See [node-types.md](references/node-types.md).

## Debugging checklist

- `WorkflowValidationError`: read every entry in `error.issues` (`code`, `nodeId`, `port`,
  `edgeIndex`, `configIssues[].path`). The fixes for each code are in
  [workflows.md](references/workflows.md#validation-issues).
- `NodeTypeRegistrationError`: `error.problems` lists every problem with the definition.
- Node unexpectedly **skipped**: an upstream port wasn't fired, or a required input is fed
  from a branch that didn't run.
- Node stuck **pending** in a failed run: it's halted behind a failed upstream node.
  `engine.resume(runId)` re-runs the failed node and what follows.
- `ResumeError`: check `error.reason` (`not-found`, `not-resumable`, `already-running`,
  `unregistered-node-types` with `error.unregistered`).
- Handler output missing on a port: a multi-port handler must return `{ port: value }`, and
  `undefined` ports aren't fired.

The full user documentation is in `docs/site/` of the
[antiflow repository](https://github.com/shaheersystems-inc/antiflow).
