---
title: Engine API
description: Reference for createEngine, the engine's methods, defineNodeType, credentialRef, createInMemoryStorage and the error classes.
---

# Engine API

Everything on this page is exported from `antiflow`.

## `createEngine(options?)`

Creates an engine: a node type registry, a scheduler, an event emitter and a storage adapter.

```ts
function createEngine(options?: EngineOptions): Engine;

interface EngineOptions {
  storage?: StorageAdapter;
  logger?: Logger;
  concurrency?: ConcurrencyOptions;
  credentials?: CredentialStore;
}

interface ConcurrencyOptions {
  global?: number;
  perNodeType?: Record<string, number>;
}
```

| Option                     | Default                    | Description                                                          |
| -------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `storage`                  | `createInMemoryStorage()`  | Where run and node records are persisted. See [Writing a storage adapter](../guides/storage-adapters.md). |
| `logger`                   | discards everything        | Receives node log entries, tagged with `runId`, `nodeId` and `attempt`. |
| `concurrency.global`       | unlimited                  | Most handler attempts running at once, across every run of the engine. |
| `concurrency.perNodeType`  | unlimited                  | Most attempts per node type id (`type@version`) at once.              |
| `credentials`              | none                       | Resolves `{ credentialId }` references. Needed only if config uses them. |

Throws a `RangeError` if a concurrency cap isn't a positive integer.

The `Engine` type is exported for typing functions that take an engine, such as
`registerCoreNodes(engine: Engine)`.

## `engine.register(nodeType)`

```ts
register(nodeType: NodeTypeDefinition): void;
```

Adds a node type to the registry under `type@version`. Several versions of a type may be
registered at once. Throws a [`NodeTypeRegistrationError`](#nodetyperegistrationerror) if that
`type@version` is already registered or the definition is malformed. See
[Node types](../concepts/node-types.md#registration).

## `engine.listNodeTypes()`

```ts
listNodeTypes(): NodeTypeInfo[];

interface NodeTypeInfo {
  id: string; // "type@version"
  type: string;
  version: number;
  inputs: string[];
  optionalInputs: string[];
  outputs: string[];
  trigger: boolean;
  display: { name: string; description?: string; category?: string; icon?: string };
  configSchema: Record<string, unknown>; // JSON Schema (draft 2020-12), input side
}
```

Every registered node type in registration order, as plain JSON (fresh copies on each call).
See [Building a UI](../guides/building-a-ui.md#the-node-catalog).

## `engine.execute(workflow, triggerInput)`

```ts
execute(workflow: WorkflowDefinition, triggerInput: JsonValue): Promise<RunHandle>;

interface RunHandle {
  id: string;
  finished: Promise<RunRecord>;
}
```

Validates the workflow, snapshots it, saves a `running` run record and starts the run.
Resolves once the run has started. `finished` resolves with the final run record when the run
is `completed`, `failed` or `cancelled`.

Rejects with a [`WorkflowValidationError`](#workflowvalidationerror) if the workflow is
invalid. Nothing runs and no run record is saved in that case.

`triggerInput` is passed as `input` to every node whose node type has no input ports.

## `engine.cancel(runId)`

```ts
cancel(runId: string): Promise<void>;
```

Cancels a run this engine is running. No new node starts, in-flight attempts see their signal
abort, and the run goes `cancelling`, then `cancelled` once they have settled (watch
`RunHandle.finished`). Resolves once the run is recorded as `cancelling`.

- Does nothing for a run that has already ended.
- Finalizes a run left `cancelling` by a crashed engine: its unfinished nodes and the run
  become `cancelled`.
- Rejects for an unknown run, or a `running` run this engine isn't running.

See [Cancellation](../guides/cancellation.md).

## `engine.resume(runId)`

```ts
resume(runId: string): Promise<RunHandle>;
```

Continues a `running` (interrupted) or `failed` run from its persisted state, against its
snapshot. Nodes recorded as `succeeded` or `skipped` keep their results. Every other node runs
again from a fresh first attempt.

Rejects with a [`ResumeError`](#resumeerror) if the run doesn't exist, isn't resumable, is
already running in this engine, or its snapshot uses node type ids that aren't registered. See
[Persistence and resume](../guides/persistence-and-resume.md).

## `engine.subscribe(listener)`

```ts
subscribe(listener: (event: EngineEvent) => void): () => void;
```

Listens to live events from every run of the engine. Returns a function that unsubscribes.
Listeners are called synchronously. An error a listener throws (or rejects with) is logged
and never affects the run or other listeners. See [Events and logging](../guides/events-and-logging.md)
and [`EngineEvent`](types.md#engineevent).

## `defineNodeType(definition)`

```ts
function defineNodeType<Config, In extends string, Out extends string, Opt extends In>(
  definition: NodeTypeDefinition<Config, In, Out, Opt>,
): NodeTypeDefinition<Config, In, Out, Opt>;
```

Returns `definition` unchanged. It lets TypeScript infer the handler's `input` type from
`inputs` and `optionalInputs`, and its `config` type from the Zod schema. See
[`NodeTypeDefinition`](types.md#nodetypedefinition).

## `createInMemoryStorage()`

```ts
function createInMemoryStorage(): StorageAdapter;
```

The reference [storage adapter](../guides/storage-adapters.md). It keeps records in memory and
stores and returns copies, so callers can't mutate stored state. Everything is lost when the
process exits.

## `credentialRef`

```ts
const credentialRef: z.ZodObject<{ credentialId: z.ZodString }>; // strict
type CredentialRef = { credentialId: string };
```

The Zod schema for a credential reference field in a node type's config. See
[Credentials](../guides/credentials.md).

## `CredentialStore`

```ts
interface CredentialStore {
  resolve(credentialId: string, context: { runId: string; nodeId: string }): Promise<JsonValue>;
}
```

Host-supplied source of secrets. If `resolve` rejects, the attempt that needed the credential
fails with `Credential "<id>" could not be resolved`.

## Errors

### `WorkflowValidationError`

```ts
class WorkflowValidationError extends Error {
  readonly issues: ValidationIssue[];
}
```

Thrown (as a rejection) by `execute()` for an invalid workflow. `issues` lists every problem.
`message` lists them one per line. See [Validation issues](validation-issues.md).

### `NodeTypeRegistrationError`

```ts
class NodeTypeRegistrationError extends Error {
  readonly nodeTypeId: string; // best effort for malformed definitions, e.g. "<no type>@1"
  readonly problems: string[];
}
```

Thrown by `register()`. `problems` lists everything wrong with the definition.

### `ResumeError`

```ts
class ResumeError extends Error {
  readonly runId: string;
  readonly reason: ResumeRefusal;
  readonly unregistered: { nodeId: string; type: string }[]; // for "unregistered-node-types"
}

type ResumeRefusal = "not-found" | "not-resumable" | "already-running" | "unregistered-node-types";
```

Thrown (as a rejection) by `resume()`. See
[When resume refuses](../guides/persistence-and-resume.md#when-resume-refuses).
