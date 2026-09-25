# antiflow — domain context

Glossary of the terms antiflow uses. Use these words (and not the listed synonyms) in
code, tests, issues, and docs. The reasoning behind the concepts lives in
[`docs/design/workflow-engine-design.md`](docs/design/workflow-engine-design.md).

## Actors

- **Host** — the application that embeds antiflow. It registers node types, supplies the
  storage adapter (and optionally a credential store), and decides when to call
  `execute()`. antiflow never owns an HTTP server, queue, or scheduler process.
  _Avoid: "server", "platform"._
- **Node author** — whoever writes a node type's handler and declares its schema/ports.
- **Adapter author** — whoever implements a storage adapter (or credential store) for a
  particular backend.

## Definitions (static)

- **Engine** — the library instance the host creates. Holds the registry, storage
  adapter, concurrency caps, and event emitter; exposes `execute`, `resume`, `cancel`,
  `listNodeTypes`.
- **Node type** — a registered, versioned kind of node: handler + Zod config schema +
  input/output port names + display metadata (name, description, category, icon).
  _Avoid: "plugin", "action", "operator"._
- **Node type id** — the string `type@version`, e.g. `core.if@1`. Several versions of the
  same type may be registered at once.
- **Registry** — the engine's set of registered node types.
- **Handler** — the node type's async function `(input, config, context) => output |
  { [port]: output }`.
- **Trigger-capable node type** — a node type flagged in metadata as requiring no inputs,
  so a UI can show where a run begins. Metadata only; antiflow implements no triggers.
- **Core nodes** — the built-in control-flow node types (If, Switch, Merge, Set, Delay),
  shipped behind a separate entry point and registered explicitly by the host.
  _Avoid: "default nodes" — nothing is registered by default._
- **Workflow definition** — the JSON describing nodes and edges. Mutable; owned by the
  host. _Avoid: "flow", "pipeline", "graph JSON"._
- **Node** — one instance of a node type inside a workflow definition: id, node type id,
  config, optional `timeoutMs` and retry policy.
- **Config** — a node's static settings, validated against its node type's Zod schema.
  Contains no expressions/templates; dynamic values arrive through ports.
- **Port** — a named input or output on a node. Each input port accepts at most one edge.
- **Optional input port** — an input port a node type marks as optional: it needn't be wired,
  and one that never resolves is left out of the node's input instead of skipping the node
  (Merge uses these to rejoin branches). Every other input port is required.
- **Edge** — a connection `nodeA:outPort → nodeB:inPort` carrying exactly one JSON value.
  _Avoid: "link", "wire", "connection"._
- **Retry policy** — `{ maxAttempts, backoff, delayMs }`, `backoff` being `'fixed' |
  'exponential' | (attempt) => delayMs` (default `'fixed'`) and `delayMs` the base delay for
  fixed/exponential backoff (default 1000).

## Execution (dynamic)

- **Run** — one execution of a workflow, started by `execute(workflowDef, triggerInput)`.
  _Avoid: "execution", "job", "instance"._
- **Trigger input** — the value passed to `execute()` that seeds the run.
- **Snapshot** — the immutable copy of the workflow definition captured when a run starts.
  All scheduling and resume use the snapshot, never the live workflow definition.
- **Attempt** — one invocation of a node's handler. Retries create new attempts; each
  starts from scratch with the same input.
- **Context** — the per-attempt object passed to a handler: `runId`, `nodeId`, `attempt`,
  `logger`, `signal` (AbortSignal), and resolved credentials.
- **Fired port** — an output port present in a handler's return value. Ports a handler
  leaves out are *not fired*.
- **Skip / skip propagation** — a node whose required input port never resolves (e.g. wired
  to an unfired port) is marked `skipped` without running; this propagates downstream.
  A skip is not a failure.
- **Branch isolation** — a failed node halts only nodes downstream of it; independent
  branches continue. Halted nodes keep their `pending` node record (they may still run if the
  failed node is retried), unlike skipped nodes, which can never run.
- **Resume** — continuing a run from persisted state against its snapshot, including
  retrying a failed node. Refused if a node type id in the snapshot isn't registered.
- **Cancel** — stop scheduling new nodes, abort in-flight attempts via their signal, and
  move `cancelling → cancelled` once in-flight work drains. No force-kill.
- **At-least-once** — the execution guarantee: a node may run more than once (e.g. crash
  before its result is persisted). Handlers must be retry-safe.

## Statuses

- **Run status** — `running`, `cancelling`, `cancelled`, `completed`, `failed`.
- **Node status** — `pending`, `running`, `succeeded`, `failed`, `skipped`, and `cancelled`
  for nodes a cancel left unrun (or stopped mid-attempt).

## Infrastructure

- **Scheduler** — internal component that dispatches ready nodes and enforces the global
  and per-node-type concurrency caps. v1 is in-process; the interface allows a
  queue-backed scheduler later.
- **Storage adapter** — the host-supplied persistence interface for run records and node
  records. Only the in-memory adapter ships. _Avoid: "database", "store" (alone)._
- **Run record** — `{ status, startedAt, completedAt, workflowSnapshot, input }`.
- **Node record** — `{ status, attempt, output | outputsByPort, error, startedAt,
  completedAt }`.
- **Event** — a live notification emitted during a run: `node:start`, `node:succeeded`,
  `node:failed`, `node:skipped`, `run:completed`, `run:failed`, `run:cancelled`. Events are
  for attached observers; the storage adapter is the source of truth.
- **Credential store** — host-supplied interface resolving a **credential reference**
  (`{ credentialId }` in config) to a secret. Resolved secrets live only in context and
  never appear in records, snapshots, events, or logs.
