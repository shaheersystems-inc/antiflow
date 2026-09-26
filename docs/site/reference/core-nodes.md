---
title: Core nodes
description: Reference for the built-in control-flow node types: If, Switch, Merge, Set and Delay.
---

# Core nodes

The core nodes are antiflow's built-in control flow. They live behind their own entry point
and are **never registered for you**:

```ts
import { registerCoreNodes } from "antiflow/nodes/core";

registerCoreNodes(engine);
```

Each node type is also exported on its own, if you want to register only some of them:

```ts
import { ifNode, switchNode, mergeNode, setNode, delayNode } from "antiflow/nodes/core";

engine.register(ifNode);
engine.register(mergeNode);
```

| Export       | Node type id    | Inputs                      | Outputs                        |
| ------------ | --------------- | --------------------------- | ------------------------------ |
| `ifNode`     | `core.if@1`     | `in`                        | `true`, `false`                |
| `switchNode` | `core.switch@1` | `in`                        | `case1` … `case8`, `default`   |
| `mergeNode`  | `core.merge@1`  | `a`, `b`, `c`, `d` (all optional) | `out`                    |
| `setNode`    | `core.set@1`    | `in` (optional)             | `out`                          |
| `delayNode`  | `core.delay@1`  | `in`                        | `out`                          |

They all have the display category `Core`. None of them is trigger-capable, so a workflow
starts from one of your own node types without input ports.

## Conditions

If and Switch test **conditions**:

```ts
{ operator: Operator; value?: JsonValue }
```

applied to the value selected by an optional **`field`**, a dot path into the input such as
`user.age` or `items.0.name`. Without `field`, the whole input is tested. A path that leads
nowhere selects nothing, which behaves as missing.

| Operator             | True when                                                                     |
| -------------------- | ----------------------------------------------------------------------------- |
| `equals`             | The selected value deep-equals `value`.                                        |
| `notEquals`          | It doesn't.                                                                    |
| `greaterThan`        | Both are numbers, or both are strings, and selected > `value`. Otherwise false. |
| `greaterThanOrEqual` | Same, with ≥.                                                                  |
| `lessThan`           | Same, with <.                                                                  |
| `lessThanOrEqual`    | Same, with ≤.                                                                  |
| `contains`           | The selected string contains `value` (a string), or the selected array has an element deep-equal to `value`. |
| `exists`             | The selected value is neither missing nor `null`. No `value`.                  |
| `truthy`             | The selected value is truthy in JavaScript (`0`, `""`, `false`, `null` and missing are falsy). No `value`. |

Every operator except `exists` and `truthy` requires `value`. Validation reports a missing one
at the config path `value`.

## `core.if@1`

Routes its input to `true` or `false` by testing a condition. The input passes through
unchanged.

**Config**

| Field      | Type        | Description                                        |
| ---------- | ----------- | -------------------------------------------------- |
| `field`    | `string?`   | Dot path into the input. The whole input if omitted. |
| `operator` | `Operator`  | See [Conditions](#conditions).                     |
| `value`    | `JsonValue?`| What to compare against.                           |

```json
{ "id": "bigOrder", "type": "core.if@1", "config": { "field": "total", "operator": "greaterThan", "value": 100 } }
```

## `core.switch@1`

Tests conditions in order and routes its input to the port of the **first** match (`case1` for
the first condition, `case2` for the second, …), or to `default` if none match. The input
passes through unchanged.

**Config**

| Field   | Type          | Description                                                    |
| ------- | ------------- | -------------------------------------------------------------- |
| `field` | `string?`     | Dot path into the input, shared by every case.                 |
| `cases` | `Condition[]` | Up to 8 conditions, `{ operator, value? }`.                    |

```json
{
  "id": "route",
  "type": "core.switch@1",
  "config": {
    "field": "priority",
    "cases": [
      { "operator": "equals", "value": "urgent" },
      { "operator": "equals", "value": "high" }
    ]
  }
}
```

Output ports are declared statically, which is why there are at most eight cases.

## `core.merge@1`

Combines the values arriving on its input ports into one output. All four inputs are
optional. Merge runs with whichever inputs arrived, and is skipped only if none of its wired
inputs arrive. Use it to rejoin the branches of an If or Switch, or to gather parallel results.

**Config**

| Field  | Type                              | Default   | Output                                           |
| ------ | --------------------------------- | --------- | ------------------------------------------------ |
| `mode` | `"array" \| "object" \| "first"`  | `"array"` | `array`: the arrived values in port order. `object`: `{ port: value }` for the arrived ports. `first`: the first arrived value in port order, or `null`. |

"First" means first in port order (`a`, `b`, `c`, `d`), not first in time. Merge runs only
after all its wired inputs have either arrived or will never arrive.

## `core.set@1`

Outputs a configured value. With `merge: true` and an object input, it outputs the input with
the value's fields laid over it.

**Config**

| Field   | Type        | Default | Description                                                           |
| ------- | ----------- | ------- | --------------------------------------------------------------------- |
| `value` | `JsonValue` |         | The value to output.                                                  |
| `merge` | `boolean`   | `false` | If both the input and `value` are objects, output `{ ...input, ...value }`. |

```json
{ "id": "tag", "type": "core.set@1", "config": { "value": { "source": "webhook" }, "merge": true } }
```

`in` is optional. A Set node with nothing wired into it runs as soon as the run starts and
outputs `value`, which makes it handy for constants. Without `merge`, or when either side isn't
an object, the output is `value` as-is.

## `core.delay@1`

Waits, then passes its input on unchanged.

**Config**

| Field | Type      | Description                                     |
| ----- | --------- | ----------------------------------------------- |
| `ms`  | `integer` | How long to wait, in milliseconds. At least 0. |

The wait honours the node's signal. If the run is cancelled, or the node's `timeoutMs` passes
first, the delay stops at once and the attempt fails. Under a cancel,
the node then ends `cancelled`.

A Delay holds a concurrency slot while it waits, like any running handler.
