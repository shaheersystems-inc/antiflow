---
title: Design and limitations
description: The principles behind antiflow, what v1 deliberately leaves out, and why.
---

# Design and limitations

antiflow's design choices were settled up front and recorded, with their reasoning, in the
[design record](https://github.com/shaheersystems/antiflow/blob/main/docs/design/workflow-engine-design.md).
This page summarizes them for users.

## Principles

**A library, not a service.** antiflow runs inside your application. It never opens a port,
owns a queue or runs a scheduler. You bring storage, and you decide when runs start.

**Core means engine only.** The `antiflow` package has no node implementations. Even If and
Switch are opt-in, behind `antiflow/nodes/core`. Integration nodes (HTTP, third-party APIs)
belong in their own packages that follow the same pattern.

**Rich metadata for UIs.** Every node type describes its ports, display info and config (as
JSON Schema), so an editor never needs a hand-maintained catalog.

**Cheap now, painful later.** Node type versioning, immutable snapshots and credential
redaction were built in from day one. They're easy to add before workflow JSON and persisted
state exist in the wild, and very hard to retrofit afterwards.

**Runtime-agnostic.** Only standard web platform APIs are used, so antiflow runs on Node, Bun,
Deno and edge runtimes.

## Guarantees and their limits

| Topic          | What you get                                                                     | What you don't |
| -------------- | -------------------------------------------------------------------------------- | -------------- |
| Execution      | **At-least-once.** Every node runs until it succeeds, fails or is cancelled.     | Exactly-once: a node can run again after a retry, resume or crash. |
| Cancellation   | New work stops immediately, and in-flight handlers are signalled.                | Force-killing a handler that ignores its signal. |
| Timeouts       | The attempt fails on time, and its signal aborts.                                | Stopping the handler's code. It keeps running if it ignores the signal. |
| Snapshots      | Runs and resumes use the workflow as it was when the run started.                | Persisting custom backoff functions. |
| Versioning     | Resume refuses to run a node against a node type id that isn't registered.       | Detecting a changed handler under the *same* version. Bump the version. |
| Redaction      | Resolved secrets are masked in records, events, logs and downstream inputs.      | Catching transformed secrets (encoded, hashed, split) or secrets shorter than 4 characters. |
| Concurrency    | Global and per-node-type caps across all runs of an engine.                      | Caps across several engines or processes. |
| Multi-process  | Durable state, resumable from any engine.                                        | Detecting two engines driving the same run. Only resume runs whose engine is gone. |

## Not in v1

These were deliberately left out of v1, and may come later:

- **Cycles and loops.** Workflows are strict DAGs. Iteration would arrive as an explicit
  loop/iterator node type, not as arbitrary cyclic graphs, to avoid infinite-loop foot-guns.
- **Sub-workflows.** A node can't invoke another workflow. This avoids nested persistence.
- **Item lists.** One JSON value per edge, with no n8n-style per-item fan-out and pairing.
  Per-item semantics could be layered on later as explicit nodes.
- **Expressions and templates in config.** Nothing like `{{$json.field}}`. Dynamic values flow
  through ports. A templating language brings parsing, sandboxed evaluation and its own
  security surface, and can be added on top without touching the core.
- **User-authored code nodes.** These would need a separate sandbox outside the core trust
  boundary.
- **Distributed execution.** Handlers run in-process. The scheduler sits behind an internal
  interface, so a queue-backed scheduler with separate workers can be added later as an
  adapter.
- **Built-in triggers.** Webhooks and cron are node metadata only. Your application calls
  `execute()`.
- **Storage adapters beyond in-memory**, integration nodes, and concrete credential stores.
