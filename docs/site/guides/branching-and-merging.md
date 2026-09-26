---
title: Branching and merging
description: Route values with If and Switch, understand skipped branches, and rejoin them with Merge.
---

# Branching and merging

Branching in antiflow is done by **multi-port node types**. A node fires only some of its
output ports, and every node on an unfired port's branch is **skipped**. The core nodes cover
the common cases: `core.if@1` and `core.switch@1` to branch, and `core.merge@1` to rejoin.

All examples assume the core nodes are registered, plus a trigger node type that passes its
trigger input on:

```ts
import { createEngine, defineNodeType } from "antiflow";
import { registerCoreNodes } from "antiflow/nodes/core";
import { z } from "zod";

const engine = createEngine();
registerCoreNodes(engine);
engine.register(
  defineNodeType({
    type: "app.start",
    version: 1,
    inputs: [],
    outputs: ["out"],
    trigger: true,
    config: z.object({}),
    display: { name: "Start" },
    handler: async (triggerInput) => triggerInput,
  }),
);

// Shorthand used below
const edge = (from: string, fromPort: string, to: string, toPort = "in") => ({
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
});
```

## If: two branches

`core.if@1` tests a condition and fires `true` or `false` with its input unchanged.

```ts
const run = await engine.execute(
  {
    nodes: [
      { id: "start", type: "app.start@1", config: {} },
      { id: "isAdult", type: "core.if@1", config: { field: "age", operator: "greaterThanOrEqual", value: 18 } },
      { id: "adult", type: "core.set@1", config: { value: { tier: "adult" }, merge: true } },
      { id: "minor", type: "core.set@1", config: { value: { tier: "minor" }, merge: true } },
    ],
    edges: [
      edge("start", "out", "isAdult"),
      edge("isAdult", "true", "adult"),
      edge("isAdult", "false", "minor"),
    ],
  },
  { name: "Ada", age: 36 },
);
await run.finished;
// adult: succeeded, output { name: "Ada", age: 36, tier: "adult" }
// minor: skipped
```

The run is `completed`. A skipped node isn't a failure.

## Skips propagate

Everything downstream of an unfired port is skipped, transitively. If `minor` fed further
nodes, they would all be skipped too, and each gets a `node:skipped` event and a `skipped`
node record.

A node is skipped when a **required** input will never resolve. A node with inputs from both
branches of an If (say a node type with required `left` and `right` inputs) would therefore
always be skipped. To rejoin branches, use a node whose inputs are **optional**, such as
Merge.

## Merge: rejoining branches

`core.merge@1` has four optional input ports, `a` to `d`. It runs with whichever inputs
arrived and is skipped only if none of its wired inputs arrive. Because each input port accepts
only one edge, Merge is also the one way to combine several values into one input.

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
// rejoin output: { name: "Ada", age: 36, tier: "adult" }
```

Merge's `mode` decides the output shape:

| `mode`             | Output                                                                     |
| ------------------ | -------------------------------------------------------------------------- |
| `array` (default)  | The values that arrived, in port order: `[a, b, …]`. Missing ports are left out. |
| `object`           | `{ a: …, b: … }`, keyed by the ports that arrived.                         |
| `first`            | The first value that arrived, in port order, or `null`.                    |

Merge also joins parallel branches that all run. For example, fetch from two APIs at once and
combine the results with `mode: "object"`.

## Switch: many branches

`core.switch@1` tests up to eight conditions in order and fires the port of the **first**
match (`case1` to `case8`), or `default` if none match.

```ts
{
  id: "route",
  type: "core.switch@1",
  config: {
    field: "country",
    cases: [
      { operator: "equals", value: "DE" }, // → case1
      { operator: "equals", value: "FR" }, // → case2
      { operator: "contains", value: "U" }, // → case3 (e.g. "US", "UK")
    ],
  },
}
```

Wire each port you care about. An unwired port is fine: firing it just leads nowhere.

## Conditions

If and Switch share one condition format:

```ts
{ field?: string, operator: Operator, value?: JsonValue }
```

- `field` is a **dot path** into the input, such as `user.age` or `items.0.name`. Without it,
  the condition tests the whole input. This is plain selection, not an expression language.
- `value` is what to compare against. `exists` and `truthy` don't use it. Every other operator
  requires it.

| Operator             | True when                                                               |
| -------------------- | ----------------------------------------------------------------------- |
| `equals`             | The selected value deep-equals `value` (JSON structural equality).       |
| `notEquals`          | It doesn't.                                                              |
| `greaterThan`        | Both are numbers, or both are strings, and selected > `value`.           |
| `greaterThanOrEqual` | As above, with ≥.                                                        |
| `lessThan`           | As above, with <.                                                        |
| `lessThanOrEqual`    | As above, with ≤.                                                        |
| `contains`           | The selected string contains `value` as a substring, or the selected array has an element deep-equal to `value`. |
| `exists`             | The selected value is neither missing nor `null`.                        |
| `truthy`             | JavaScript truthiness (`0`, `""`, `false`, `null` and missing are falsy). |

Comparing values of different types (a number and a string) with an ordering operator is
always `false`.

## Writing your own branching node

Any node type with several output ports branches the same way. Return only the ports you want
to fire. See [Multi-port node types](writing-node-types.md#multi-port-node-types).

## Reference

- [Core nodes](../reference/core-nodes.md): every core node's config, ports and behaviour.
- [Branching and skips](../concepts/execution.md#branching-and-skips): the exact skip rules.
