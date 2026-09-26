---
title: Quickstart
description: Create an engine, register a node type, run a workflow and read its results.
---

# Quickstart

This page walks through the whole loop: create an engine, register node types, run a
workflow, watch it, and read the results from storage.

## 1. Create an engine

```ts
import { createEngine, createInMemoryStorage } from "antiflow";

const storage = createInMemoryStorage();
const engine = createEngine({ storage });
```

Every option is optional. Without `storage`, the engine uses its own in-memory adapter.
Keeping a reference to the adapter lets you read run records later. In production you'd pass
an adapter backed by your database. See
[Writing a storage adapter](../guides/storage-adapters.md).

## 2. Define and register node types

A node type is a typed async handler with a config schema, port names and display metadata.

```ts
import { defineNodeType } from "antiflow";
import { z } from "zod";

// No input ports, so it receives the run's trigger input.
const greet = defineNodeType({
  type: "demo.greet",
  version: 1,
  inputs: [],
  outputs: ["out"],
  config: z.object({ greeting: z.string().default("Hello") }),
  display: { name: "Greet", description: "Greets the trigger input", category: "Demo" },
  handler: async (name, config) => `${config.greeting}, ${name}!`,
});

// One input port, `in`. Its handler receives `{ in: <value> }`.
const shout = defineNodeType({
  type: "demo.shout",
  version: 1,
  inputs: ["in"],
  outputs: ["out"],
  config: z.object({}),
  display: { name: "Shout" },
  handler: async (input) => String(input.in).toUpperCase(),
});

engine.register(greet);
engine.register(shout);
```

`defineNodeType` only helps TypeScript infer the handler's `input` and `config` types.
Registration checks the definition and throws a `NodeTypeRegistrationError` listing every
problem if it's malformed or already registered.

## 3. Execute a workflow

A workflow definition is plain JSON: nodes that reference node types by `type@version`, and
edges that connect an output port to an input port.

```ts
const workflow = {
  nodes: [
    { id: "hello", type: "demo.greet@1", config: { greeting: "Hi" } },
    { id: "loud", type: "demo.shout@1", config: {} },
  ],
  edges: [{ from: { node: "hello", port: "out" }, to: { node: "loud", port: "in" } }],
};

const run = await engine.execute(workflow, "Ada");
console.log(run.id); // a UUID
```

`execute()` validates the workflow, saves a run record and starts running. It resolves as
soon as the run has started, with a handle holding the run's `id` and a `finished` promise.
If the workflow is invalid, it rejects with a `WorkflowValidationError` and nothing runs.

## 4. Watch it run

Subscribe before executing to see every event:

```ts
const unsubscribe = engine.subscribe((event) => {
  console.log(event.type, "nodeId" in event ? event.nodeId : "");
});
```

For the workflow above this logs:

```
node:start hello
node:succeeded hello
node:start loud
node:succeeded loud
run:completed
```

## 5. Read the results

`run.finished` resolves with the final run record. Each node's result lives in its node
record in storage:

```ts
const finished = await run.finished;
console.log(finished.status); // "completed"

for (const record of await storage.listNodeRecords(run.id)) {
  console.log(record.nodeId, record.status, record.output);
}
// hello succeeded Hi, Ada!
// loud succeeded HI, ADA!
```

The storage adapter is the source of truth. Anyone not attached to the live events, such as
a UI opened later or a process that restarted, reads state from there.

## 6. Add the core nodes

Branching, merging, fixed values and delays come from the core nodes, which you register
explicitly:

```ts
import { registerCoreNodes } from "antiflow/nodes/core";

registerCoreNodes(engine);
// Registers core.if@1, core.switch@1, core.merge@1, core.set@1 and core.delay@1
```

Every core node takes its input through an `in` port, so a workflow starts from one of your
own node types that has no input ports, like `demo.greet` above. Such a node receives the
run's trigger input. Mark it `trigger: true` so a UI can show it as the place a run begins.

## Where next

- [Workflows](../concepts/workflows.md): nodes, ports, edges and validation in depth.
- [Writing node types](../guides/writing-node-types.md): multi-port handlers, the context
  object, retry-safety.
- [Branching and merging](../guides/branching-and-merging.md) with the core nodes.
- [Engine API reference](../reference/engine.md).
