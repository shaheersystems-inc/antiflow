---
title: What is antiflow?
description: A JSON-declared, nodes-and-edges workflow engine you embed as a library underneath your own automation product.
---

# What is antiflow?

antiflow is a workflow execution engine for TypeScript. You describe a workflow as JSON, as
**nodes** connected by **edges** between named ports. You hand it to an engine, and the
engine runs it: concurrently, observably and resumably.

It's built to be the **backend layer underneath a visual automation product** like n8n or
Make.com. It has no UI and no HTTP server, queue or cron process of its own. It gives a UI
everything it needs to render a node palette, config forms and a live run canvas.

```ts
import { createEngine, defineNodeType } from "antiflow";
import { registerCoreNodes } from "antiflow/nodes/core";
import { z } from "zod";

const engine = createEngine();
registerCoreNodes(engine);

// Where a run begins: no input ports, so it receives the trigger input.
engine.register(
  defineNodeType({
    type: "app.manual",
    version: 1,
    inputs: [],
    outputs: ["out"],
    trigger: true,
    config: z.object({}),
    display: { name: "Manual trigger" },
    handler: async (triggerInput) => triggerInput,
  }),
);

const run = await engine.execute(
  {
    nodes: [
      { id: "start", type: "app.manual@1", config: {} },
      { id: "check", type: "core.if@1", config: { field: "amount", operator: "greaterThan", value: 100 } },
      { id: "flag", type: "core.set@1", config: { value: { review: true }, merge: true } },
    ],
    edges: [
      { from: { node: "start", port: "out" }, to: { node: "check", port: "in" } },
      { from: { node: "check", port: "true" }, to: { node: "flag", port: "in" } },
    ],
  },
  { amount: 250 },
);

const finished = await run.finished; // status: "completed"; "flag" output { amount: 250, review: true }
```

## Who it's for

- **Host developers** building an automation product. antiflow runs inside your app, on your
  runtime, and stores state in your database.
- **Node authors** writing the steps of a workflow (HTTP calls, database writes, AI calls,
  anything else). A node type is a typed async function plus a config schema and metadata.
- **UI developers** building a workflow editor. Every node type describes itself as plain
  JSON, including a JSON Schema for its config. Validation errors come back as structured
  data, and live events drive progress on a canvas.
- **Adapter authors** plugging antiflow into Postgres, Redis or any other datastore through a
  four-method storage interface.

## Features

- **JSON workflow definitions.** A directed acyclic graph of nodes and edges between named
  ports, validated against your registered node types before anything runs.
- **Typed, versioned node types.** Each has a handler, a [Zod](https://zod.dev) config
  schema, ports and display metadata. Its identity includes a version (`core.if@1`), so old
  runs keep working after an upgrade.
- **Concurrent execution.** Every node whose inputs are ready runs at once, within optional
  global and per-node-type concurrency caps.
- **Branching.** Multi-port nodes fire only some of their outputs. Downstream nodes on an
  untaken branch are _skipped_, and an explicit Merge node rejoins branches.
- **Failure isolation.** A failed node halts only its own downstream branch. Independent
  branches keep running.
- **Timeouts and retries.** Set per node, with fixed, exponential or custom backoff.
- **Cancellation.** Stops new work at once and signals in-flight handlers through an
  `AbortSignal`.
- **Durable, resumable runs.** Run and node state go through a pluggable storage adapter.
  Runs replay against an immutable snapshot of the workflow and can be resumed after a crash
  or to retry failed nodes.
- **Live events.** `node:start`, `node:succeeded`, `node:failed`, `node:skipped`,
  `run:completed`, `run:failed` and `run:cancelled`.
- **Credentials with redaction.** Secrets are resolved from your own vault and handed to
  handlers. They never reach persisted state, events or logs.
- **Runtime-agnostic.** No Bun-, Node- or Deno-only APIs in the library.

## What antiflow deliberately doesn't do

antiflow stays a small, embeddable engine. It leaves out:

- **No server, queue or scheduler.** Triggers (webhooks, cron, manual runs) are node
  _metadata_ only. Your application decides when to call `engine.execute()`.
- **No cycles or loops.** Workflows are strict DAGs in v1.
- **No sub-workflows.**
- **No per-item fan-out.** Exactly one JSON value flows along each edge. There's no n8n-style
  "items" list.
- **No expressions or templates in config.** There's nothing like `{{$json.field}}`. Dynamic
  values flow through ports and edges.
- **No user-authored code nodes.** Node types are registered by the host.
- **No exactly-once guarantee.** Execution is
  [at-least-once](concepts/execution.md#at-least-once-execution), so handlers must be
  retry-safe.

See [Design and limitations](design.md) for the reasoning behind each of these.

## Packages

antiflow ships three entry points:

| Entry point           | What it contains                                                                 |
| --------------------- | -------------------------------------------------------------------------------- |
| `antiflow`            | The engine, the registration API, the in-memory storage adapter and all types. No node implementations. |
| `antiflow/nodes/core` | The core control-flow nodes (If, Switch, Merge, Set, Delay) and `registerCoreNodes`. |
| `antiflow/testing`    | The storage adapter conformance suite.                                           |

## Next steps

- [Install antiflow](getting-started/installation.md)
- [Run your first workflow](getting-started/quickstart.md)
- [Learn the core concepts](concepts/workflows.md)
