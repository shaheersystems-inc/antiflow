# antiflow

A nodes-and-edges workflow execution engine, declared via JSON, meant to be the
**backend/library** layer underneath something like an n8n or Make.com — no UI, no owned
HTTP/scheduler service, but rich enough in its type/metadata surface to be plugged into one.

Written in TypeScript and runtime-agnostic (no Bun-only APIs in the library itself); Bun is
used only as the dev/build/test tool.

> **Status**: v1 in progress. See
> [`docs/design/workflow-engine-design.md`](docs/design/workflow-engine-design.md) for the
> full set of architectural decisions and the reasoning behind them.

## Writing node types: the execution guarantee

antiflow runs every handler **at least once, not exactly once**. A handler may run more
than once for the same node of the same run:

- a **retry** re-invokes it from scratch, with the same input, after a failed or timed-out
  attempt;
- a **resume** (`engine.resume(runId)`) re-runs every node that hadn't persisted a
  `succeeded` result — including one whose handler had finished when the process died but
  whose result wasn't stored yet — and retries failed nodes;
- a **timeout** or **cancel** only aborts the handler's `signal`; a handler that ignores it
  keeps running even though its attempt has already ended.

So write handlers to be retry-safe: make side effects idempotent (e.g. pass an idempotency
key derived from `context.runId` and `context.nodeId`), and honour `context.signal`.

## Install

```bash
bun install
```

## Run

```bash
bun run index.ts
```

---

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
