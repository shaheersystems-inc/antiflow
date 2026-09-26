---
title: Building a UI
description: Use the node type catalog, structured validation issues and live events to build a workflow editor on antiflow.
---

# Building a UI

antiflow has no UI, but it's designed to sit under one. This guide maps the pieces of a
typical workflow editor onto the engine's API.

| UI feature                  | antiflow API                                               |
| --------------------------- | ---------------------------------------------------------- |
| Node palette                | `engine.listNodeTypes()`: `display`, `trigger`             |
| Node shapes and handles     | `inputs`, `optionalInputs`, `outputs`                      |
| Config forms                | `configSchema` (JSON Schema)                               |
| Saving a workflow           | Your own storage of the `WorkflowDefinition` JSON          |
| Error highlighting          | `WorkflowValidationError.issues`                           |
| "Run" button                | `engine.execute(workflow, triggerInput)`                   |
| Live progress on the canvas | `engine.subscribe()`                                       |
| Run history and details     | Run records and node records from your storage adapter     |
| "Stop" and "Retry" buttons  | `engine.cancel(runId)`, `engine.resume(runId)`              |

## The node catalog

`engine.listNodeTypes()` returns every registered node type, in registration order, as plain
JSON. You can send it straight to a browser. The UI never needs Zod or the handler code.

```json
{
  "id": "core.merge@1",
  "type": "core.merge",
  "version": 1,
  "inputs": ["a", "b", "c", "d"],
  "optionalInputs": ["a", "b", "c", "d"],
  "outputs": ["out"],
  "trigger": false,
  "display": {
    "name": "Merge",
    "description": "Combines values from several branches into one",
    "category": "Core",
    "icon": "merge"
  },
  "configSchema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "mode": {
        "type": "string",
        "enum": ["array", "object", "first"],
        "default": "array",
        "description": "array: arrived values in port order; object: keyed by port; first: the first arrived value"
      }
    }
  }
}
```

- **Palette.** Group by `display.category`, and show `display.name`, `display.description` and
  `display.icon`. The icon is a free-form string. The core nodes use icon names like `split`,
  `signpost`, `merge`, `pencil` and `hourglass`, which you can map to your own icon set.
- **Versions.** Several versions of a type can be registered at once. Show the newest in the
  palette and keep older ones for existing workflows. Store `id` (`type@version`) in the
  workflow's `type` field.
- **Start nodes.** `trigger: true` marks a node type as a place where a run begins. Render it
  as an entry point. Trigger-capable node types never have inputs.
- **Handles.** Draw one handle per port. Mark `optionalInputs` so users know those ports can
  stay unconnected. Every other input must be wired before the workflow can run.
- **Config forms.** `configSchema` is JSON Schema (draft 2020-12) of the config's **input**
  side, so fields with defaults are optional. Feed it to a JSON Schema form library such as
  react-jsonschema-form or JSON Forms. Field descriptions come from `.describe()` in the Zod
  schema. Parts of a Zod schema that JSON Schema can't express are left unconstrained, and
  the engine still enforces them at validation time.
- **Credentials.** A credential field shows up as an object with a single `credentialId`
  string and the description _"A reference to a credential in the host's credential store"_.
  Render it as a picker over the credentials your application manages. See
  [Credentials](credentials.md).

## Enforcing editor rules

Mirror the engine's graph rules in the editor so users can't build what validation would
reject:

- Only connect an output handle to an input handle.
- Allow at most **one** edge into each input port. Suggest a Merge node when a user tries a
  second.
- Reject connections that would create a cycle.

## Validation feedback

Validate by attempting to run, or when saving if you keep an engine around for it. A
`WorkflowValidationError` lists every problem, each tagged with where it is:

```ts
try {
  await engine.execute(workflow, input);
} catch (error) {
  if (!(error instanceof WorkflowValidationError)) throw error;
  for (const issue of error.issues) {
    if ("edgeIndex" in issue) highlightEdge(issue.edgeIndex, issue.message);
    else if ("nodeIds" in issue) issue.nodeIds.forEach((id) => highlightNode(id, issue.message));
    else highlightNode(issue.nodeId, issue.message);

    if (issue.code === "invalid-config") {
      for (const { path, message } of issue.configIssues) highlightField(issue.nodeId, path, message);
    }
  }
}
```

A real response for a workflow with a bad Merge mode and a miswired If:

```json
[
  {
    "code": "invalid-config",
    "nodeId": "m",
    "message": "Node \"m\" has invalid config",
    "configIssues": [
      { "path": ["mode"], "message": "Invalid option: expected one of \"array\"|\"object\"|\"first\"" }
    ]
  },
  {
    "code": "unknown-port",
    "edgeIndex": 0,
    "nodeId": "i",
    "port": "yes",
    "direction": "output",
    "message": "Edge 0 uses output port \"yes\" on node \"i\", which its node type doesn't declare"
  },
  {
    "code": "unconnected-input-port",
    "nodeId": "i",
    "port": "in",
    "message": "Input port \"in\" on node \"i\" has no incoming edge"
  }
]
```

See [Validation issues](../reference/validation-issues.md) for every code.

## Live runs

Subscribe to events and update node states on the canvas as they arrive: pending, running,
succeeded, failed or skipped. See
[Streaming a run to a UI](events-and-logging.md#streaming-a-run-to-a-ui). When
`run:cancelled` arrives, render every node that isn't final yet as cancelled.

## Run history

For past runs, or a run opened mid-flight, read from storage:

- The run record's `workflowSnapshot` is the exact graph that ran. Render history from it, not
  from the current version of the workflow, which may have changed since.
- Each node record has the status, attempt count, result (`output` or `outputsByPort`),
  error and timestamps for that node.

## Triggers

Where runs come from is up to your application. antiflow has no webhook server or scheduler.
A webhook endpoint, a cron job or a "Run" button all end in the same call:

```ts
const run = await engine.execute(workflow, triggerInput);
```

Every node without input ports receives `triggerInput`, such as a webhook's request body or a
cron tick's timestamp.
