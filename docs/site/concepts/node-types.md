---
title: Node types
description: What a node type is made of, how it's identified and versioned, and how it's registered.
---

# Node types

A **node type** is a kind of node that a host registers with the engine. It has a typed
handler, a config schema, named ports and display metadata. Workflows can only use
registered node types. There are no inline scripts or user-authored code nodes.

```ts
import { defineNodeType } from "antiflow";
import type { JsonValue } from "antiflow";
import { z } from "zod";

export const httpGet = defineNodeType({
  type: "http.get",
  version: 1,
  inputs: ["in"],
  outputs: ["out"],
  config: z.object({
    url: z.url().describe("The URL to fetch"),
    headers: z.record(z.string(), z.string()).default({}),
  }),
  display: {
    name: "HTTP GET",
    description: "Fetches a URL and outputs the JSON response",
    category: "HTTP",
    icon: "globe",
  },
  handler: async (_input, config, { signal }) => {
    const response = await fetch(config.url, { headers: config.headers, signal });
    if (!response.ok) throw new Error(`GET ${config.url} failed with ${response.status}`);
    return (await response.json()) as JsonValue;
  },
});
```

## Anatomy

| Field            | Required | Description                                                                          |
| ---------------- | -------- | ------------------------------------------------------------------------------------ |
| `type`           | yes      | The type name, e.g. `http.get`. Non-empty, without `@`. Use a namespace prefix such as `core.` or `app.`. |
| `version`        | yes      | An integer ≥ 1. Together with `type` it forms the node type id.                      |
| `inputs`         | yes      | Input port names. `[]` means the node receives the run's trigger input.              |
| `optionalInputs` | no       | Input ports (among `inputs`) that may stay unwired or unresolved.                    |
| `outputs`        | yes      | Output port names. One port means the handler returns a bare value. Several means it returns a map of fired ports. |
| `config`         | yes      | A Zod schema for the node's config.                                                  |
| `display`        | yes      | `{ name, description?, category?, icon? }` for a UI.                                 |
| `trigger`        | no       | `true` marks the node type as trigger-capable (metadata only).                      |
| `handler`        | yes      | `async (input, config, context) => output`.                                          |

`defineNodeType()` returns its argument unchanged. It exists so TypeScript can infer
`input` and `config` for the handler from `inputs`, `optionalInputs` and `config`.

## Node type ids and versions

A node type is identified by its **node type id**, `type@version`, such as `http.get@1`.
Workflows reference node types by this id.

Several versions of the same type can be registered at once:

```ts
engine.register(httpGetV1); // http.get@1
engine.register(httpGetV2); // http.get@2
```

Bump the version when a change would break existing workflows or in-flight runs: a new
config shape, renamed ports, or different behaviour. Keep the old version registered for as
long as stored workflows or unfinished runs use it. A run's snapshot records the exact
node type id each node was authored against. [Resume](../guides/persistence-and-resume.md)
refuses to continue a run if any of those ids is no longer registered. It never silently
runs a node against a different version.

## Registration

```ts
engine.register(httpGet);
```

Registration checks the definition at runtime, so hosts written in plain JavaScript get the
same safety. It throws a `NodeTypeRegistrationError` listing **every** problem if:

- the `type@version` is already registered
- `type` is empty or contains `@`, or `version` isn't an integer ≥ 1
- `inputs`, `outputs` or `optionalInputs` aren't arrays of unique, non-empty strings, or
  `optionalInputs` names a port not in `inputs`
- `config` isn't a Zod schema, or can't be described as JSON Schema
- `display.name` is missing or empty, or `description`, `category` or `icon` isn't a string
- `handler` isn't a function
- `trigger` isn't a boolean, or a trigger-capable node type declares input ports

```ts
import { NodeTypeRegistrationError } from "antiflow";

try {
  engine.register(broken);
} catch (error) {
  if (error instanceof NodeTypeRegistrationError) {
    console.error(error.nodeTypeId, error.problems);
  }
}
```

Mistakes surface when your application starts, not when a workflow first runs.

## Config schemas

The `config` schema is used for three things:

1. **Validation.** `execute()` rejects a workflow whose node config fails the schema, with
   each schema error's path.
2. **Parsing.** The handler receives the _parsed_ config, so defaults are filled in and
   transforms applied. The workflow definition and snapshot keep the config as written.
3. **Describing.** `engine.listNodeTypes()` converts the schema into JSON Schema, which a UI
   can use to render a config form. Use `.describe()` on fields to give them help text.

Config is static JSON. It has no expressions or templates, so anything that varies per run
arrives through input ports.

## Trigger-capable node types

A node type with `trigger: true` tells a UI "a run can begin here", so the UI can render a
proper start node. It must declare no input ports.

It's **metadata only**. antiflow doesn't implement webhooks, cron schedules or any other
trigger mechanism. Your application decides when to call
`engine.execute(workflow, triggerInput)`, and every node without input ports, trigger-capable
or not, receives `triggerInput`.

```ts
const webhook = defineNodeType({
  type: "app.webhook",
  version: 1,
  inputs: [],
  outputs: ["out"],
  trigger: true,
  config: z.object({ path: z.string() }),
  display: { name: "Webhook", category: "Triggers", icon: "webhook" },
  // Your HTTP server calls execute() with the request body; this node passes it on.
  handler: async (body) => body,
});
```

## The core nodes

antiflow's core package contains no node types. The built-in control-flow nodes (If, Switch,
Merge, Set, Delay) are regular node types behind the `antiflow/nodes/core` entry point. They
use only the public API, and you register them explicitly:

```ts
import { registerCoreNodes } from "antiflow/nodes/core";
registerCoreNodes(engine);
```

See [Core nodes](../reference/core-nodes.md). For everything about handlers (return values,
the context, retry-safety), see [Writing node types](../guides/writing-node-types.md).
