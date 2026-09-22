# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Scaffolded via `bun init`, not yet implemented. `index.ts` is still the placeholder
`bun init` prints; no engine code, tests, or build/lint tooling exist yet. The architecture
is fully designed — see below — so implementation should follow that design rather than
inventing structure ad hoc.

Once real source, tests, and tooling exist, update this file with:
- Build, lint, and test commands (including how to run a single test)
- Any structure notes that go beyond the architecture summary below

## What antiflow is

A nodes-and-edges workflow execution engine, declared via JSON, meant to be the
**backend/library** layer underneath something like an n8n or Make.com — no UI, no owned
HTTP/scheduler service, but rich enough in its type/metadata surface to be plugged into one.

## Runtime

- TypeScript, runtime-agnostic (no Bun-only APIs in the library itself) — Bun is only the
  dev/build/test tool.
- Pure embeddable library: no owned HTTP server, job queue, or scheduler process. The host
  supplies storage/queue adapters via pluggable interfaces; an in-memory adapter is the
  only one that ships in core.
- Package boundary: the core package is engine + extension/registration API only, zero
  node implementations. Built-in control-flow nodes (If, Switch, Merge, Set, Delay) live
  behind a separate entry point (e.g. `antiflow/nodes/core`) that a host must explicitly
  import and register. Integration nodes (HTTP, third-party APIs, auth) follow the same
  pattern as their own package(s).

## Graph model

- Strict DAG for v1 — no cycles, no loop/iterator node, no sub-workflow composition yet.
- Edges connect named ports (`nodeA:portOut → nodeB:portIn`); each input port accepts at
  most one incoming edge (use an explicit Merge node to combine branches).
- A single JSON value flows per edge — no n8n-style per-item fan-out/pairing semantics.
- A node is marked `skipped` (not run, not errored) if a required input port never
  resolves (e.g. wired to the untaken branch of an If/Switch); skip propagates downstream.

## Node contract

- Nodes are pre-registered, typed handlers only — no inline/user-authored script nodes.
- Handler signature: `async (input, config, context) => output | { [portName]: output }`.
  A single-output node returns a bare value; a multi-port node (If, Switch) returns a
  partial map of only the port(s) it fired. `context` provides `runId`, `nodeId`,
  `attempt`, `logger`, `AbortSignal`.
- Every registered node type declares a Zod config schema, its input/output port names,
  and display metadata; the engine validates workflow JSON against these at load time and
  exposes them (e.g. `engine.listNodeTypes()`).
- Node type identity includes a version (e.g. `"core.if@1"`); a workflow snapshot records
  the version each node was authored against, and resume refuses to proceed if the
  currently-registered handler version differs. Multiple versions of the same type can be
  registered simultaneously.
- Optional per-node `timeoutMs` (aborts the handler via `AbortSignal`, then fails it,
  subject to retry policy) and retry policy `{ maxAttempts, backoff }` where `backoff` is
  `'fixed' | 'exponential' | ((attempt) => delayMs)`. Retries fully re-invoke the handler
  from scratch — node authors must write idempotent-ish, retry-safe handlers.

## Execution

- All nodes with satisfied dependencies run concurrently, not strictly sequentially. The
  engine (not workflow JSON) exposes an optional global concurrency cap and per-node-type
  cap.
- Strictly in-process for v1 — the scheduler calls handlers directly as async functions in
  the same event loop, but sits behind an internal interface so a distributed/queue-backed
  scheduler can be added later as an adapter, without a core redesign.
- Cancel: stop scheduling new nodes immediately, signal running nodes via `AbortSignal`
  (best-effort, no force-kill), transition `cancelling → cancelled` once in-flight work
  drains.
- Error isolation: a node failure only halts its own branch; independent branches keep
  running. A failed node persists resumable state so the host can retry just that node.
- Execution guarantee is **at-least-once, not exactly-once** — a crash between a handler
  completing and its result being persisted may cause a re-run on resume. This is an
  explicit contract for node authors, not an oversight.

## Persistence & observability

- Execution state is durable/serializable via a persistence interface (in-memory adapter
  ships by default; real deployments swap in Postgres/Redis/etc.).
- Persisted shape: run record `{ status, startedAt, completedAt, workflowSnapshot, input }`;
  per-node record `{ status, attempt, output | outputsByPort, error, startedAt, completedAt }`.
- `execute()` captures an immutable snapshot of the workflow definition at start time;
  resume always replays against that snapshot, never a since-edited live version.
- The engine emits live events during `execute()` — `node:start | node:succeeded |
  node:failed | node:skipped`, `run:completed | run:failed | run:cancelled` — for an
  attached UI. The storage adapter is the durable source of truth for anyone not attached
  live.

## Triggers

Triggers (webhook, cron, manual) are only **node metadata** (trigger-capable /
requires-no-inputs), so a UI can render where a run begins. The library never implements a
webhook server or cron scheduler — the runtime surface is just
`engine.execute(workflowDef, triggerInput)`; the host decides when to call it.

## Explicitly deferred / rejected for v1

Cyclic graphs/loop nodes, sub-workflow composition, item-list ("each item") data model,
inline/user-authored code nodes, built-in expression/templating language in node config
(e.g. n8n-style `{{$json.field}}`), and distributed/queue-backed execution. See
[`docs/design/workflow-engine-design.md`](docs/design/workflow-engine-design.md) for the
full reasoning behind each of these and everything above — treat it as the source of truth
and update it (not just this file) if an architectural decision changes.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on shaheersystems/antiflow (via `gh`). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
