# Workflow definitions

## Contents

- [Shape](#shape)
- [Wiring rules](#wiring-rules)
- [What each node receives](#what-each-node-receives)
- [Core nodes](#core-nodes)
- [Conditions](#conditions)
- [Branching and merging patterns](#branching-and-merging-patterns)
- [Skips and failures](#skips-and-failures)
- [Timeouts and retries](#timeouts-and-retries)
- [Validation issues](#validation-issues)
- [Authoring checklist](#authoring-checklist)

## Shape

```ts
import type { WorkflowDefinition } from "antiflow";

const workflow: WorkflowDefinition = {
  nodes: [
    { id: "fetch", type: "app.fetchOrder@1", config: { baseUrl: "https://api.example.com" } },
    { id: "check", type: "core.if@1", config: { field: "total", operator: "greaterThan", value: 100 } },
    {
      id: "notify",
      type: "app.notify@2",
      config: { channel: "#sales" },
      timeoutMs: 5000,
      retry: { maxAttempts: 3, backoff: "exponential", delayMs: 500 },
    },
  ],
  edges: [
    { from: { node: "fetch", port: "out" }, to: { node: "check", port: "in" } },
    { from: { node: "check", port: "true" }, to: { node: "notify", port: "in" } },
  ],
};
```

- `id`: unique within the workflow. Used in edges, records and events.
- `type`: a registered node type id, **with** the version (`"core.if@1"`, not `"core.if"`).
- `config`: required, even if it's `{}`. Static JSON validated by the node type's schema.
  It contains no expressions.
- `timeoutMs` (positive number) and `retry` are optional, per node.

A workflow is plain data. Store it as JSON, send it over HTTP, let a UI edit it. Only custom
`backoff` functions aren't JSON.

A small helper keeps edges readable in code:

```ts
const edge = (from: string, fromPort: string, to: string, toPort = "in") => ({
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
});
```

## Wiring rules

- Edges go from an **output** port to an **input** port, and both ports must be declared by
  the node types.
- **Each input port has at most one incoming edge.** Use `core.merge@1` to combine values.
- An output port can feed any number of edges (fan-out). Unwired output ports are fine.
- **Required input ports must be wired.** Only ports in the node type's `optionalInputs` may
  stay unwired.
- The graph must be acyclic. A self-edge is a cycle.
- One JSON value flows per edge. An array is one value, with no per-item iteration.

## What each node receives

- A node type with **no input ports** receives the trigger input passed to
  `execute(workflow, triggerInput)`. A workflow may have several such nodes, and each gets
  the trigger input. Every workflow needs at least one host node type with `inputs: []` to
  start from, because the core nodes all have inputs (except `core.set@1`, whose `in` is
  optional, so an unwired Set runs at start and outputs its constant).
- Any other node receives `{ [inputPort]: value }` for the ports that received a value.

## Core nodes

Registered with `registerCoreNodes(engine)` from `antiflow/nodes/core`, or one at a time
(`ifNode`, `switchNode`, `mergeNode`, `setNode`, `delayNode`).

| Id | Inputs | Outputs | Config |
| -- | ------ | ------- | ------ |
| `core.if@1` | `in` | `true`, `false` | `{ field?, operator, value? }`. Passes the input through unchanged on the fired port. |
| `core.switch@1` | `in` | `case1`…`case8`, `default` | `{ field?, cases: [{ operator, value? }] }`, up to 8 cases. The first match wins, otherwise `default`. Passes the input through. |
| `core.merge@1` | `a`, `b`, `c`, `d` (all optional) | `out` | `{ mode?: "array" \| "object" \| "first" }`, default `"array"`. |
| `core.set@1` | `in` (optional) | `out` | `{ value, merge?: boolean }`. Outputs `value`. With `merge: true` and object input and value: `{ ...input, ...value }`. |
| `core.delay@1` | `in` | `out` | `{ ms: integer >= 0 }`. Waits, then passes the input on. Aborts on cancel or timeout. |

Merge modes: `array` gives the arrived values in port order (`a`, `b`, `c`, `d`; missing
ones left out). `object` gives `{ port: value }` for the arrived ports. `first` gives the first
arrived value in **port order** (not time order), or `null`. Merge runs only once every wired
input has arrived or will never arrive, and is skipped only if none arrive.

## Conditions

If and Switch share `field` (an optional dot path into the input, such as `user.age` or
`items.0.name`; omitted means the whole input; a path leading nowhere selects "missing") and
each condition's `{ operator, value? }`:

| Operator | True when |
| -------- | --------- |
| `equals` / `notEquals` | Deep (JSON structural) equality, or its negation. |
| `greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual` | Both numbers, or both strings, and the comparison holds. Mixed types are always false. |
| `contains` | The selected string contains `value` (a string), or the selected array has an element deep-equal to `value`. |
| `exists` | The selected value is neither missing nor `null`. Takes no `value`. |
| `truthy` | JavaScript truthiness (`0`, `""`, `false`, `null` and missing are falsy). Takes no `value`. |

Every operator except `exists` and `truthy` **requires** `value`. Leaving it out is an
`invalid-config` issue at path `value` (If) or `cases.N.value` (Switch). `field` is plain
selection, not an expression language.

## Branching and merging patterns

**If, then rejoin with Merge** (note the optional Merge ports):

```ts
{
  nodes: [
    { id: "start", type: "app.start@1", config: {} },
    { id: "isAdult", type: "core.if@1", config: { field: "age", operator: "greaterThanOrEqual", value: 18 } },
    { id: "adult", type: "core.set@1", config: { value: { tier: "adult" }, merge: true } },
    { id: "minor", type: "core.set@1", config: { value: { tier: "minor" }, merge: true } },
    { id: "rejoin", type: "core.merge@1", config: { mode: "first" } },
  ],
  edges: [
    edge("start", "out", "isAdult"),
    edge("isAdult", "true", "adult"),
    edge("isAdult", "false", "minor"),
    edge("adult", "out", "rejoin", "a"),
    edge("minor", "out", "rejoin", "b"),
  ],
}
// input { name: "Ada", age: 36 } → rejoin output { name: "Ada", age: 36, tier: "adult" }; "minor" skipped
```

**Switch with a default:**

```ts
{ id: "route", type: "core.switch@1", config: {
  field: "country",
  cases: [{ operator: "equals", value: "DE" }, { operator: "equals", value: "FR" }],
} }
// edges from "route" ports "case1", "case2" and "default"
```

**Parallel fan-out, then gather:** wire one output to several nodes (they run concurrently),
then gather their outputs into `core.merge@1` with `mode: "object"`. For more than four values,
chain Merges.

**Several values into one custom node:** give the node type several input ports
(`inputs: ["order", "customer"]`) and wire each from a different upstream node. Don't wire two
edges into one port.

**Anti-pattern:** a node with **required** inputs fed from both sides of an If is always
skipped, because one side never fires. Put a Merge (optional inputs) in between, or make those
ports optional in the node type.

## Skips and failures

- An input **resolves** when its upstream node succeeded and fired that port. It **never
  resolves** when the upstream was skipped, or succeeded without firing the port.
- A node is **skipped** if a required input never resolves, or none of its wired inputs
  resolve. Skips propagate downstream. Skipped isn't failed: a run with only succeeded and
  skipped nodes is `completed`.
- A **failed** node (it threw, returned an invalid result, or timed out, with no retries left)
  halts only its downstream nodes, which stay `pending`. Independent branches keep running.
  The run ends `failed` and can be resumed to re-run just the failed part.

## Timeouts and retries

```ts
{ id: "charge", type: "payments.charge@1", config: { amount: 4200 },
  timeoutMs: 10_000,
  retry: { maxAttempts: 4, backoff: "exponential", delayMs: 500 } }
```

- `timeoutMs` bounds **one attempt**. When it passes, the signal aborts and the attempt fails
  at once with `Attempt timed out after <timeoutMs>ms`. That failure counts against the retry
  policy.
- `maxAttempts` counts **total** attempts, including the first (integer ≥ 1). Without
  `retry`, a node gets a single attempt.
- `backoff`: `"fixed"` (default) waits `delayMs` every time. `"exponential"` waits
  `delayMs * 2^(n-1)` after attempt n. A function `(attempt) => ms` must return a
  non-negative finite number. `delayMs` defaults to 1000.
- Each retry re-invokes the handler from scratch with the same input. A backoff doesn't hold
  a concurrency slot.
- Custom backoff functions aren't persisted in the snapshot. After a resume from storage, that
  node falls back to `"fixed"`. Prefer `"fixed"` or `"exponential"` for resumable workflows
  and for workflows stored as JSON.

## Validation issues

`execute()` rejects with `WorkflowValidationError` before anything runs or is saved.
`error.issues` lists **every** problem. Each has a `code` and `message` plus locating fields.

| `code` | Fields | Fix |
| ------ | ------ | --- |
| `duplicate-node-id` | `nodeId` | Make node ids unique. |
| `unknown-node-type` | `nodeId` | Register the node type, or fix the `type@version` (the version must be included and registered). That node's config and ports aren't checked until this is fixed. |
| `invalid-config` | `nodeId`, `configIssues[{ path, message }]` | Fix config at each `path` (relative to the node's config) against the node type's schema. |
| `invalid-timeout` | `nodeId` | `timeoutMs` must be a positive finite number, or left out. |
| `invalid-retry-policy` | `nodeId` | `maxAttempts` an integer ≥ 1. `backoff` `"fixed"`, `"exponential"` or a function. `delayMs` ≥ 0 and finite. |
| `unknown-edge-node` | `edgeIndex`, `nodeId` | The edge references a node id that's not in `nodes`. |
| `unknown-port` | `edgeIndex`, `nodeId`, `port`, `direction` | Use a port the node type declares (`direction: "output"` is the `from` end). Check `listNodeTypes()`. |
| `unconnected-input-port` | `nodeId`, `port` | Wire the required input, or make it optional in the node type. |
| `multiple-input-edges` | `nodeId`, `port`, `edgeIndexes` | Only one edge per input port. Route the values through `core.merge@1`. |
| `cycle` | `nodeIds` | Remove an edge to break the cycle. v1 has no loops. |

```ts
try {
  await engine.execute(workflow, input);
} catch (error) {
  if (!(error instanceof WorkflowValidationError)) throw error;
  for (const issue of error.issues) console.error(issue.code, issue.message);
}
```

## Authoring checklist

1. Every `type` is a registered `type@version`. Check with `engine.listNodeTypes()` (each
   entry's `id`, `inputs`, `optionalInputs`, `outputs`, `configSchema`).
2. At least one node type with no inputs starts the workflow.
3. Every required input port has exactly one incoming edge, and no port has two.
4. Port names on edges match the node types' declared ports exactly.
5. Config matches each schema. Per-run data comes through ports, not config.
6. Branches that rejoin go through optional inputs (Merge).
7. Nodes with side effects have a sensible `timeoutMs`, and a `retry` only if the handler is
   idempotent.
