---
title: Types
description: The TypeScript types for workflow definitions, node types, records, events and statuses.
---

# Types

All types are exported from `antiflow`:

```ts
import type { WorkflowDefinition, NodeRecord, EngineEvent } from "antiflow";
```

## `JsonValue`

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
```

The values that flow along edges, get returned by handlers and get persisted.

## Workflow definition

### `WorkflowDefinition`

```ts
interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: Edge[];
}
```

### `WorkflowNode`

```ts
interface WorkflowNode {
  id: string;
  type: string; // node type id, "type@version"
  config: unknown; // validated against the node type's config schema
  timeoutMs?: number; // no timeout if unset
  retry?: RetryPolicy; // a single attempt if unset
}
```

### `Edge`

```ts
interface Edge {
  from: { node: string; port: string }; // an output port
  to: { node: string; port: string }; // an input port
}
```

### `RetryPolicy` and `Backoff`

```ts
interface RetryPolicy {
  maxAttempts: number; // total attempts, including the first
  backoff?: Backoff; // default "fixed"
  delayMs?: number; // base delay, default 1000
}

type Backoff = "fixed" | "exponential" | ((attempt: number) => number);
```

See [Timeouts and retries](../guides/timeouts-and-retries.md).

## Node types

### `NodeTypeDefinition`

```ts
interface NodeTypeDefinition<Config, In extends string, Out extends string, Opt extends In = never> {
  type: string;
  version: number;
  inputs: readonly In[];
  optionalInputs?: readonly Opt[];
  outputs: readonly Out[];
  config: z.ZodType<Config>;
  display: DisplayMetadata;
  trigger?: boolean;
  handler: (input: NodeInput<In, Opt>, config: Config, context: NodeContext) => Promise<JsonValue>;
}
```

See [Node types](../concepts/node-types.md#anatomy).

### `NodeInput`

```ts
type NodeInput<In, Opt> = [In] extends [never]
  ? JsonValue // no input ports: the trigger input
  : { [P in Exclude<In, Opt>]: JsonValue } & { [P in Opt]?: JsonValue };
```

### `DisplayMetadata`

```ts
interface DisplayMetadata {
  name: string;
  description?: string;
  category?: string;
  icon?: string;
}
```

### `NodeContext`

```ts
interface NodeContext {
  runId: string;
  nodeId: string;
  attempt: number; // 1-based
  logger: Logger;
  signal: AbortSignal; // aborts on timeout or cancel
  credentials: Readonly<Record<string, JsonValue>>; // keyed by credential id
}
```

### `Logger`

```ts
interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
```

Used both for `createEngine({ logger })` and for `context.logger`.

### `AnyNodeType`

A node type with its config and port types erased, as the registry holds it. Useful when you
store heterogeneous node types in a list:

```ts
const appNodes: AnyNodeType[] = [httpGet, slackPost];
for (const nodeType of appNodes) engine.register(nodeType);
```

## Records

### `RunRecord`

```ts
interface RunRecord {
  id: string;
  status: RunStatus;
  startedAt: string; // ISO 8601
  completedAt?: string; // set once the run ends; cleared on resume
  workflowSnapshot: WorkflowDefinition; // without custom backoff functions
  input: JsonValue; // the trigger input
}
```

### `NodeRecord`

```ts
interface NodeRecord {
  runId: string;
  nodeId: string;
  status: NodeStatus;
  attempt: number; // 0 if no attempt started
  output?: JsonValue; // a single-output node's result
  outputsByPort?: Record<string, JsonValue>; // a multi-port node's result: fired ports only
  error?: string;
  startedAt?: string;
  completedAt?: string;
}
```

### `RunStatus` and `NodeStatus`

```ts
type RunStatus = "running" | "cancelling" | "cancelled" | "completed" | "failed";
type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
```

See [Statuses](../concepts/execution.md#statuses) for what each means.

### `StorageAdapter`

```ts
interface StorageAdapter {
  saveRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  saveNodeRecord(record: NodeRecord): Promise<void>;
  listNodeRecords(runId: string): Promise<NodeRecord[]>;
}
```

See [Writing a storage adapter](../guides/storage-adapters.md).

## Events

### `EngineEvent`

```ts
type EngineEvent =
  | { type: "node:start"; runId: string; nodeId: string; attempt: number }
  | { type: "node:succeeded"; runId: string; nodeId: string; attempt: number }
  | { type: "node:failed"; runId: string; nodeId: string; attempt: number; error: string }
  | { type: "node:skipped"; runId: string; nodeId: string }
  | { type: "run:completed"; runId: string }
  | { type: "run:failed"; runId: string }
  | { type: "run:cancelled"; runId: string };

type EngineEventType = EngineEvent["type"];
```

See [Events and logging](../guides/events-and-logging.md).

## Also exported

| Type                | Described in                                             |
| ------------------- | -------------------------------------------------------- |
| `Engine`, `EngineOptions`, `RunHandle`, `ResumeRefusal` | [Engine API](engine.md)    |
| `ConcurrencyOptions` | [Engine API](engine.md#createengineoptions)              |
| `NodeTypeInfo`       | [Engine API](engine.md#enginelistnodetypes)              |
| `CredentialStore`, `CredentialRef` | [Engine API](engine.md#credentialstore)    |
| `ValidationIssue`    | [Validation issues](validation-issues.md)                |
