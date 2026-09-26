---
title: Workflows
description: Workflow definitions: nodes, ports, edges, the data that flows between them, and how they're validated.
---

# Workflows

A **workflow definition** is the JSON that describes what to run. It lists **nodes** and the
**edges** that connect them. It's plain data, so you can store it in a database, send it over
HTTP and let a UI edit it.

```ts
import type { WorkflowDefinition } from "antiflow";

const workflow: WorkflowDefinition = {
  nodes: [
    { id: "fetch", type: "app.fetchOrder@1", config: { baseUrl: "https://api.example.com" } },
    { id: "check", type: "core.if@1", config: { field: "total", operator: "greaterThan", value: 100 } },
    { id: "notify", type: "app.notify@2", config: { channel: "#sales" }, timeoutMs: 5000 },
  ],
  edges: [
    { from: { node: "fetch", port: "out" }, to: { node: "check", port: "in" } },
    { from: { node: "check", port: "true" }, to: { node: "notify", port: "in" } },
  ],
};
```

## Nodes

A **node** is one use of a [node type](node-types.md) inside a workflow.

| Field       | Required | Description                                                                          |
| ----------- | -------- | ------------------------------------------------------------------------------------ |
| `id`        | yes      | Unique within the workflow. Used in edges, node records and events.                  |
| `type`      | yes      | The node type id, `type@version`, e.g. `core.if@1`. It must be registered.          |
| `config`    | yes      | The node's static settings, validated against the node type's Zod schema.            |
| `timeoutMs` | no       | Fails an attempt that runs longer than this. See [Timeouts and retries](../guides/timeouts-and-retries.md). |
| `retry`     | no       | Retry policy `{ maxAttempts, backoff?, delayMs? }`.                                  |

**Config is static.** It has no expressions or templates. A value that depends on the run
(an id from an upstream node, the trigger payload) reaches the node through an input port,
not through its config.

## Ports and edges

Every node type declares named **input ports** and **output ports**. An **edge** connects one
node's output port to another node's input port:

```json
{ "from": { "node": "check", "port": "true" }, "to": { "node": "notify", "port": "in" } }
```

The rules are:

- **Each input port accepts at most one edge.** To combine values from several branches, wire
  them into a Merge node, which has several input ports. There's no implicit merge.
- **An output port can feed any number of edges.** Fan-out is free.
- **Exactly one JSON value flows along an edge.** There's no per-item iteration: an array is
  just one value.
- **Required input ports must be wired.** An input port is required unless its node type lists
  it in `optionalInputs`. Optional input ports may be left unwired.
- **Unwired output ports are fine.**

## What a node receives

What a handler gets as `input` depends on its node type's input ports:

- **A node type with no input ports** receives the run's **trigger input**, the value passed to
  `engine.execute(workflow, triggerInput)`. This is how a run begins. Any number of nodes in
  a workflow can have no input ports, and each receives the trigger input.
- **A node type with input ports** receives an object with one entry per input port that
  received a value:

  ```ts
  // A node type with inputs ["left", "right"]
  handler: async (input) => [input.left, input.right];
  ```

  An optional input port that's unwired, or whose upstream never fired, is absent from the
  object.

## The graph must be a DAG

Workflows are **directed acyclic graphs**. An edge path that leads from a node back to itself
is a validation error. There are no loop or iterator nodes in v1.

## Validation

`engine.execute()` validates the workflow against the registered node types before anything
runs. If anything is wrong, it rejects with a `WorkflowValidationError` whose `issues` array
lists **every** problem found, not just the first:

```ts
import { WorkflowValidationError } from "antiflow";

try {
  await engine.execute(workflow, input);
} catch (error) {
  if (error instanceof WorkflowValidationError) {
    for (const issue of error.issues) {
      console.log(issue.code, issue.message);
      // e.g. "invalid-config"         Node "notify" has invalid config
      //      "multiple-input-edges"   Input port "in" on node "merge" has 2 incoming edges; ...
    }
  }
}
```

Validation checks for:

- duplicate node ids
- node types that aren't registered, including a version that isn't registered
- config that fails the node type's schema, with each schema error's path
- an invalid `timeoutMs` or retry policy
- edges that reference a node not in the workflow, or a port the node type doesn't declare
- required input ports with no incoming edge
- input ports with more than one incoming edge
- cycles

Each issue is structured data (`code`, `nodeId`, `port`, `edgeIndex`…) so a UI can highlight
the offending nodes and edges. See [Validation issues](../reference/validation-issues.md) for
every code and its fields.

When validation fails, nothing runs and no run record is saved.

## Snapshots

When a run starts, the engine captures an immutable **snapshot** of the workflow definition:
a deep copy, frozen, stored in the run record as `workflowSnapshot`. The run executes only
against that snapshot, and so does any later [resume](../guides/persistence-and-resume.md).
Editing, or even mutating, the workflow object you passed to `execute()` has no effect on
runs already started.

One exception: a custom backoff _function_ in a retry policy can't be stored. It stays in the
live run's in-memory snapshot, but it's left out of the persisted one. See
[Timeouts and retries](../guides/timeouts-and-retries.md#custom-backoff-and-resume).
