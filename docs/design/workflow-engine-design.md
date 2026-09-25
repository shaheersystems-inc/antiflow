# antiflow — workflow engine design

Status: design settled via grilling session on 2026-09-22, not yet implemented.

This document is the record of architectural decisions for antiflow: a nodes-and-edges
workflow execution engine, declared via JSON, meant to be the **backend/library** layer
underneath something like an n8n or Make.com — no UI, no owned HTTP/scheduler service,
but rich enough in its type/metadata surface to be plugged into one.

Each decision below includes the "why" that was given at the time, so future changes can
weigh the same tradeoffs rather than re-litigating from scratch.

## Runtime & packaging

- **Language/runtime**: TypeScript, written runtime-agnostic — no Bun-only APIs in the
  library itself. Bun is used only as the dev/build/test tool.
  _Why: maximizes embeddability (Node, Bun, Deno, edge) at near-zero cost._

- **Deployment shape**: Pure embeddable library, not a self-contained service. No owned
  HTTP server, no owned job queue, no owned scheduler process. The host application
  supplies storage and queue adapters through pluggable interfaces; an in-memory adapter
  ships as the default.
  _Why: matches "backend engine to plug into a UI," not a hosted product._

- **Package boundary**: The core package exports only the engine + extension/registration
  API — zero node implementations. Built-in control-flow nodes (If, Switch, Merge, Set,
  Delay) live behind a separate entry point (e.g. `antiflow/nodes/core`) that a host must
  explicitly import and register. Future integration nodes (HTTP, third-party APIs, auth)
  will follow the same pattern as their own separate package(s).
  _Why: keeps "core = engine only" an enforced boundary, not just a stated intention._

## Graph model

- **Graph shape**: Strict DAG for v1. No cycles, no loop/iterator node yet — iteration is
  deferred, to be added later as an explicit loop/iterator node type rather than allowing
  arbitrary cyclic graphs. Sub-workflows (a node invoking another whole workflow) are also
  out of scope for v1.
  _Why: avoids infinite-loop foot-guns and nested-persistence complexity; v1 stays simple
  without designing anything that would block adding these later._

- **Ports and edges**: Edges connect named ports (`nodeA:portOut → nodeB:portIn`), not bare
  node-to-node. Each input port accepts **at most one** incoming edge — combining values
  from multiple upstream branches requires an explicit Merge node.
  _Why: named ports are required for branching nodes (If/Switch need distinct true/false
  outputs); the one-edge-per-input-port rule keeps every node's input unambiguous with no
  implicit merge-conflict policy to design._

- **Data model**: A single JSON value flows per edge. No automatic per-item fan-out /
  "items list" semantics (the n8n item-pairing model was explicitly rejected for v1).
  _Why: item-list semantics (pairing, per-item error handling, binary data) is a large
  complexity jump; can be layered later as an explicit node once iteration is added._

- **Skip propagation**: A node is marked `skipped` (not run, not errored) if any of its
  required input ports never resolves — e.g. it's wired only to the untaken branch of an
  upstream If/Switch. Skip status propagates transitively downstream.
  _Why: matches n8n/Make branch semantics; prevents handlers from ever silently running
  with partial/garbage input._

  Input ports are required unless the node type lists them in `optionalInputs`. A required
  input port must be wired, and validation rejects a workflow with an unconnected one. An
  optional input port may be left unwired. If it never resolves, it's left out of the input
  rather than skipping the node. A node is still skipped if none of its wired inputs ever
  resolve. This is what lets the core Merge node rejoin the branches of an If or Switch.

  A multi-port handler fires exactly the ports present in its returned map (a port whose
  value is `undefined` counts as not fired); a single-output handler always fires its port.

## Node contract

- **Registration model**: Nodes are pre-registered, typed handlers only. No inline/
  user-authored script nodes (no "Code node" equivalent) in v1 — deferred as a separately
  sandboxed extension if added later, kept outside the core trust boundary.

- **Handler signature**:
  ```ts
  async (input, config, context) => output | { [portName]: output }
  ```
  A single-output node returns a bare value; a multi-port node (If, Switch) returns a
  partial map containing only the port(s) it actually fired.
  _Why return-value over a `context.emit(port, value)` call: keeps handlers pure/testable
  as plain functions, and "did this node produce port X" is answerable just by inspecting
  the return value — useful for persistence/replay._

  `context` provides: `runId`, `nodeId`, `attempt`, `logger`, `AbortSignal`.

- **Node type metadata**: Every registered node type must declare a config schema (Zod),
  its input/output port names, and display metadata (name, description, category/icon for
  UI grouping). The engine validates workflow JSON against these schemas at load time and
  exposes them via something like `engine.listNodeTypes()`.
  _Why: this is the main lever for "rich enough to plug into a UI" — without it, any UI
  has to hand-maintain a parallel catalog of what each node needs._

  `listNodeTypes()` returns plain JSON per node type: node type id, type, version, ports,
  trigger flag, display metadata, and the config schema converted to JSON Schema (the
  Zod schema's input side, so defaulted fields are optional) — a form a UI can render
  without depending on Zod. Registration rejects a duplicate `type@version` and any
  malformed definition (listing every problem), so mistakes surface at startup.

- **Node type versioning**: Node type identity includes a version (e.g. `"core.if@1"`).
  A workflow snapshot (see below) records which version each node was authored against.
  On resume, the engine refuses to proceed if the currently-registered handler version for
  a node type differs from the snapshot's recorded version, rather than silently resuming
  against possibly-incompatible behavior. The engine allows multiple versions of the same
  type to be registered simultaneously so old snapshots keep resolving correctly after an
  upgrade.
  _Why: a workflow snapshot is immutable, but the handler *code* behind a node type isn't
  part of that snapshot — it's looked up live by type string. Without versioning, a host
  upgrading a node package while a run is paused could silently resume against a breaking
  change. Cheap to add to the identity format now, hard to retrofit once workflow JSON is
  already in the wild (same reasoning as credentials and snapshotting below)._

- **Timeouts**: Optional `timeoutMs` per node in workflow JSON (undefined = no timeout).
  On timeout, the engine aborts the handler via `AbortSignal` and marks it failed, subject
  to the node's retry policy.

- **Retries**: Optional per-node retry policy: `{ maxAttempts, backoff }` where
  `backoff` is `'fixed' | 'exponential' | ((attempt) => delayMs)`. A retry is a full
  re-invocation of the handler from scratch with the same input — no partial in-node
  progress is preserved. Node authors are expected to write idempotent-ish/retry-safe
  handlers (see execution guarantee, below).

  Concretely: `retry: { maxAttempts, backoff = 'fixed', delayMs = 1000 }`. Fixed waits
  `delayMs` between attempts; exponential waits `delayMs * 2^(n-1)` after failed attempt
  `n`; a custom function receives `n` and returns the delay. Each attempt waits for its own
  scheduler slot (a backoff doesn't hold one). A timeout aborts the attempt's signal and
  fails the attempt at once, without waiting for a handler that ignores its signal; that
  handler keeps its slot until it really settles, so the caps stay true. A custom backoff
  returning anything but a non-negative finite number fails the node. Between
  attempts the node record stays `running` with the failed attempt's error; `node:start`
  fires per attempt, `node:failed` only once attempts run out. A custom backoff function
  isn't serializable, so the persisted snapshot omits it, and a run resumed from storage
  uses the default backoff for that node.

- **Core nodes** (`antiflow/nodes/core`, registered with `registerCoreNodes(engine)`):
  - `core.if@1` fires `true` or `false` with its input.
  - `core.switch@1` fires the first matching of `case1`–`case8`, else `default`. Output
    ports are declared statically, so the number of cases is capped.
  - `core.merge@1` has optional ports `a`–`d`. It outputs the arrived values as an array,
    an object or the first value.
  - `core.set@1` outputs a configured JSON value, optionally laid over an object input.
  - `core.delay@1` waits `ms`, then passes its input on, and stops early when its signal
    aborts.

  Conditions are `{ operator, value }`, applied to an optional dot-path `field` of the
  input. That is plain selection, not a templating or expression language.

## Execution

- **Concurrency**: All nodes whose dependencies are satisfied execute concurrently (not
  strictly sequential). The engine exposes an optional global concurrency cap and an
  optional per-node-type cap (e.g. to rate-limit a particular API-calling node type),
  configured on the engine, not in workflow JSON.
  _Why: most nodes are I/O-bound (HTTP calls etc.); sequential-only execution would waste
  most of the value of a DAG engine._

  Configured as `createEngine({ concurrency: { global, perNodeType } })`. Caps apply across
  every run of the engine; `perNodeType` is keyed by node type id (`type@version`). A node
  waiting on its node type's cap doesn't hold back other node types queued behind it.

- **Execution locality**: Strictly in-process for v1 — the scheduler calls node handlers
  directly as async functions in the same process/event loop as the engine. No message-
  passing/serialization constraint on handler input/output. The scheduler itself sits
  behind an internal interface so a distributed/queue-backed scheduler (handlers running
  in separate worker processes, à la n8n's queue mode) could be added later as a separate
  adapter package, without a core redesign.
  _Why: real distributed execution is a large complexity jump for a v1 embeddable library,
  and forcing handlers to be message-serializable from day one is a heavy constraint to
  impose immediately._

- **Cancellation**: On cancel, the engine stops scheduling new nodes immediately, signals
  already-running nodes via `AbortSignal` (best-effort — well-behaved handlers bail early),
  and does not forcibly kill them. The run transitions `cancelling → cancelled` once
  in-flight work actually drains.

  Concretely: `engine.cancel(runId)` aborts the run's cancel signal and records the run
  `cancelling`. Nodes waiting for a scheduler slot or in a retry backoff stop without
  another attempt; in-flight attempts see their signal abort. Once they settle the run is
  `cancelled` (`run:cancelled`). An in-flight node that still succeeds stays `succeeded`;
  one that ends in an error is `cancelled` (keeping the error, since it was most likely
  caused by the abort), as is every node left unrun. No `node:*` event is emitted for
  cancelled nodes: `run:cancelled` tells an attached UI that every node not yet terminal was
  cancelled, and the storage adapter holds the details. A cancel that arrives once in-flight
  work has drained and the run is being finalized has no effect.

- **Error isolation**: A node failure only halts its own branch. Independent branches (that
  don't depend on the failed node) keep running to completion. A failed node persists a
  resumable state so the host can retry just that node later without re-running the whole
  graph.

  Concretely: every node gets a `pending` node record when the run starts. A thrown error
  (or an invalid handler result) marks the node `failed` with the error message; its
  downstream nodes stay `pending` (halted, not skipped). Once everything runnable has
  finished, the run ends `failed` and `run:failed` is emitted.

- **Execution guarantee**: At-least-once, not exactly-once — documented as an explicit
  contract for node authors. A crash between a handler completing and its result being
  persisted means resume may re-run that node.
  _Why: this is what virtually every real workflow engine actually guarantees in practice;
  exactly-once would require every pluggable storage adapter to support transactional
  commits, which contradicts the "simple pluggable adapters" goal._

## Persistence & observability

- **Durability**: Execution state is durable and serializable via a persistence interface
  (in-memory adapter ships by default; real deployments swap in Postgres/Redis/etc.).
  _Why: real workflows (webhook waits, human approval steps) can be paused for hours or
  days — retrofitting durability after the fact into an already-designed execution model
  is painful, so it's designed in from the start even though only an in-memory adapter
  ships initially._

- **Persisted shape**:
  - Run record: `{ status, startedAt, completedAt, workflowSnapshot, input }`
  - Per-node record: `{ status, attempt, output | outputsByPort, error, startedAt, completedAt }`

- **Workflow snapshot immutability**: `execute()` captures an immutable snapshot of the
  workflow definition at start time. Resume always replays against that snapshot, never
  against a since-edited "live" version of the workflow.
  _Why: without this, editing a workflow while any run is in-flight is a landmine — nodes
  could disappear or ports could be renamed out from under a resumed run._

  Concretely: the snapshot is deep-frozen. `engine.resume(runId)` loads the run record and
  its node records from storage, refuses (`ResumeError`, naming each node) if any
  `type@version` in the snapshot isn't registered, keeps `succeeded` and `skipped` nodes as
  they are, and runs every other node again with a fresh set of attempts. Runs that are
  `running` (interrupted) or `failed` can be resumed; `completed`, `cancelling` and
  `cancelled` runs can't (refusals are a `ResumeError` with a `reason`). A run a crashed
  engine left `cancelling` is finalized by calling `cancel()` on it. Only one engine may
  drive a run at a time; the library can't detect a run still live in another process, so
  the host must only resume runs whose engine is gone.

- **Live progress**: The engine emits events during `execute()` —
  `node:start | node:succeeded | node:failed | node:skipped`,
  `run:completed | run:failed | run:cancelled` — for a UI attached to a live run. The
  storage adapter remains the durable source of truth for anyone not attached live (e.g.
  after a process restart, or a UI that opens mid-run).

## Triggers

- Triggers (webhook, cron, manual) are represented only as **node metadata** — a node type
  can declare itself trigger-capable / requires-no-inputs — purely so a UI can render "this
  is where the run begins" as part of a complete graph. Concretely, a node type sets
  `trigger: true`; registration rejects a trigger-capable node type that declares input
  ports. The library itself never implements
  a webhook server or a cron scheduler. The runtime surface is just
  `engine.execute(workflowDef, triggerInput)`; the host owns deciding *when* to call it.
  _Why: keeps the "pure embeddable library" boundary intact while still giving a UI enough
  information to render a real workflow canvas._

## Explicitly deferred / rejected for v1

- **Cyclic graphs / loop nodes** — deferred, DAG only for now.
- **Sub-workflow composition** — deferred.
- **Item-list ("each item") data model** — rejected in favor of single-value-per-edge.
- **Inline/user-authored code nodes** — deferred as a future, separately-sandboxed
  extension, not part of the initial trust boundary.
- **Built-in expression/templating language in node config** (e.g. n8n-style
  `{{$json.field}}` references inside static config) — explicitly rejected for v1. Dynamic
  values must flow through real input ports/edges, not templated strings resolved by the
  engine. A large standalone feature (parsing, sandboxed eval, its own security surface)
  that would dominate the project if bundled now; can be layered on top later without
  touching the core.
- **Distributed/queue-backed execution** — not built now, but the scheduler is designed
  behind an interface so it can be added later as an adapter.

## Extension points defined now but unused by core v1

- **Credentials**: A `CredentialStore` interface plus a way for node config to reference
  `{ credentialId: "..." }`, with a hard guarantee that resolved credential values are
  injected via `context` but are **never captured in persisted execution state or logs**.
  No concrete implementation or integration nodes ship in core yet.
  _Why: nothing uses this in v1, but retrofitting secret-redaction into an already-shipped
  persistence format later is exactly the kind of thing that's cheap now and painful after
  the fact — same reasoning as node-type versioning and workflow snapshotting above._

  Concretely: `createEngine({ credentials })` takes a `CredentialStore` with one method,
  `resolve(credentialId, { runId, nodeId })`. A node type declares a reference field with
  the exported `credentialRef` schema. Before each attempt, every `{ credentialId }` object
  in the node's config is resolved, and the secrets are handed to the handler as
  `context.credentials[credentialId]`. The snapshot and records keep only the reference.
  Everything derived from the attempt is redacted by exact string match (any secret string
  leaf of 4+ characters becomes `[redacted]`) before it leaves the attempt: logger messages
  and fields, the returned output (so downstream nodes see it redacted too), and the error.
  A reference that can't be resolved, or has no store to resolve it, fails the attempt with
  an error naming only the credential id, never the store's own error.

## Open / not yet decided

Nothing remaining in the architecture-level design tree was left open at the end of the
grilling session — the frontier was explicitly confirmed empty by the user. Anything not
listed above (exact JSON field names, package/module naming, validation error message
format, testing utilities, license/open-source status) is an implementation detail to be
decided during scaffolding, not a settled architectural decision.
