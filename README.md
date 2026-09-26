# antiflow

A nodes-and-edges workflow execution engine, declared via JSON, meant to be the
**backend/library** layer underneath something like an n8n or Make.com — no UI, no owned
HTTP/scheduler service, but rich enough in its type/metadata surface to be plugged into one.

Written in TypeScript and runtime-agnostic (no Bun-only APIs in the library itself); Bun is
used only as the dev/build/test tool.

- **Typed, versioned node types** with Zod config schemas and UI metadata (`listNodeTypes()`
  returns JSON Schema for config forms).
- **Concurrent DAG execution** with global and per-node-type concurrency caps.
- **Branching and skip propagation**, with explicit Merge nodes to rejoin branches.
- **Failure isolation, timeouts, retries and cancellation.**
- **Durable, resumable runs** through a pluggable storage adapter, replayed against an
  immutable snapshot.
- **Live events** for a UI, and **credentials** that never reach storage, events or logs.

```ts
import { createEngine, defineNodeType } from "antiflow";
import { registerCoreNodes } from "antiflow/nodes/core";
import { z } from "zod";

const engine = createEngine();
registerCoreNodes(engine);
engine.register(
  defineNodeType({
    type: "demo.greet",
    version: 1,
    inputs: [],
    outputs: ["out"],
    trigger: true,
    config: z.object({ greeting: z.string().default("Hello") }),
    display: { name: "Greet" },
    handler: async (name, config) => `${config.greeting}, ${name}!`,
  }),
);

const run = await engine.execute(
  { nodes: [{ id: "hello", type: "demo.greet@1", config: {} }], edges: [] },
  "Ada",
);
console.log((await run.finished).status); // "completed"
```

> **Status**: the v1 engine is implemented. It isn't published to npm yet
> ([#30](https://github.com/shaheersystems/antiflow/issues/30)).

## Documentation

The documentation lives in [`docs/site/`](docs/site/index.md) and is written to be published
as the official docs site:

- [What is antiflow?](docs/site/index.md)
- Getting started: [Installation](docs/site/getting-started/installation.md) ·
  [Quickstart](docs/site/getting-started/quickstart.md)
- Core concepts: [Workflows](docs/site/concepts/workflows.md) ·
  [Node types](docs/site/concepts/node-types.md) ·
  [Runs and execution](docs/site/concepts/execution.md)
- Guides: [Writing node types](docs/site/guides/writing-node-types.md) ·
  [Branching and merging](docs/site/guides/branching-and-merging.md) ·
  [Timeouts and retries](docs/site/guides/timeouts-and-retries.md) ·
  [Cancellation](docs/site/guides/cancellation.md) ·
  [Persistence and resume](docs/site/guides/persistence-and-resume.md) ·
  [Events and logging](docs/site/guides/events-and-logging.md) ·
  [Credentials](docs/site/guides/credentials.md) ·
  [Building a UI](docs/site/guides/building-a-ui.md) ·
  [Writing a storage adapter](docs/site/guides/storage-adapters.md) ·
  [Testing](docs/site/guides/testing.md)
- Reference: [Engine API](docs/site/reference/engine.md) ·
  [Types](docs/site/reference/types.md) ·
  [Validation issues](docs/site/reference/validation-issues.md) ·
  [Core nodes](docs/site/reference/core-nodes.md) ·
  [`antiflow/testing`](docs/site/reference/testing.md)
- [Design and limitations](docs/site/design.md) · [Glossary](docs/site/glossary.md)

The section order for a docs site generator is in
[`docs/site/sidebar.json`](docs/site/sidebar.json). The architectural decisions and their
reasoning are recorded in
[`docs/design/workflow-engine-design.md`](docs/design/workflow-engine-design.md).

## Writing node types: the execution guarantee

antiflow runs every handler **at least once, not exactly once**: retries, resumes and
crashes can run a handler again for the same node of the same run. Make side effects
idempotent (e.g. an idempotency key derived from `context.runId` and `context.nodeId`) and
honour `context.signal`. See
[Runs and execution](docs/site/concepts/execution.md#at-least-once-execution).

## Development

```bash
bun install
bun test
bun run typecheck
```
