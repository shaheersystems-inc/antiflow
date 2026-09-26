---
title: Validation issues
description: Every ValidationIssue code that execute() can report, with its fields.
---

# Validation issues

`engine.execute()` rejects an invalid workflow with a `WorkflowValidationError`. Its `issues`
array holds one `ValidationIssue` per problem. Every issue has a `code` and a human-readable
`message`, plus fields that locate the problem.

```ts
import { WorkflowValidationError } from "antiflow";
import type { ValidationIssue } from "antiflow";
```

Every problem is reported, not only the first. A node whose type isn't registered gets an
`unknown-node-type` issue, but its config and ports can't be checked, so they aren't.

## Node issues

### `duplicate-node-id`

```ts
{ code: "duplicate-node-id"; nodeId: string; message: string }
```

More than one node uses `nodeId`. Reported once per duplicated id.

### `unknown-node-type`

```ts
{ code: "unknown-node-type"; nodeId: string; message: string }
```

The node's `type` (`type@version`) isn't registered. This includes a known type with a version
that isn't registered.

### `invalid-config`

```ts
{
  code: "invalid-config";
  nodeId: string;
  message: string;
  configIssues: { path: (string | number)[]; message: string }[];
}
```

The node's config fails its node type's Zod schema. `configIssues` has one entry per schema
error, with `path` relative to the node's config (e.g. `["cases", 0, "value"]`).

### `invalid-timeout`

```ts
{ code: "invalid-timeout"; nodeId: string; message: string }
```

`timeoutMs` is set but isn't a positive finite number.

### `invalid-retry-policy`

```ts
{ code: "invalid-retry-policy"; nodeId: string; message: string }
```

`retry` isn't an object, `maxAttempts` isn't an integer ≥ 1, `backoff` isn't `"fixed"`,
`"exponential"` or a function, or `delayMs` isn't a non-negative finite number. The message
lists every problem.

## Edge issues

### `unknown-edge-node`

```ts
{ code: "unknown-edge-node"; edgeIndex: number; nodeId: string; message: string }
```

The edge at `edgeIndex` (in `workflow.edges`) references `nodeId`, which isn't in the
workflow.

### `unknown-port`

```ts
{
  code: "unknown-port";
  edgeIndex: number;
  nodeId: string;
  port: string;
  direction: "input" | "output";
  message: string;
}
```

The edge uses a port that the node's node type doesn't declare. `direction` says which end:
`"output"` for `from`, `"input"` for `to`.

## Port issues

### `unconnected-input-port`

```ts
{ code: "unconnected-input-port"; nodeId: string; port: string; message: string }
```

A required input port has no incoming edge. Ports listed in the node type's `optionalInputs`
may stay unconnected.

### `multiple-input-edges`

```ts
{ code: "multiple-input-edges"; nodeId: string; port: string; edgeIndexes: number[]; message: string }
```

An input port has more than one incoming edge. `edgeIndexes` lists them all. Use a Merge node
to combine values.

## Graph issues

### `cycle`

```ts
{ code: "cycle"; nodeIds: string[]; message: string }
```

The nodes in `nodeIds` form a cycle, listed in workflow order. Each group of nodes that lie on
a cycle together (a strongly connected component) is one issue. A node with an edge to itself
is a cycle of one.
