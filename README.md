# antiflow

A nodes-and-edges workflow execution engine, declared via JSON, meant to be the
**backend/library** layer underneath something like an n8n or Make.com — no UI, no owned
HTTP/scheduler service, but rich enough in its type/metadata surface to be plugged into one.

Written in TypeScript and runtime-agnostic (no Bun-only APIs in the library itself); Bun is
used only as the dev/build/test tool.

> **Status**: design settled, not yet implemented. See
> [`docs/design/workflow-engine-design.md`](docs/design/workflow-engine-design.md) for the
> full set of architectural decisions and the reasoning behind them.

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
