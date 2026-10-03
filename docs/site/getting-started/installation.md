---
title: Installation
description: Requirements and how to add antiflow to a project.
---

# Installation

> [!WARNING]
> antiflow hasn't been published to npm yet. Publishing is tracked in
> [#30](https://github.com/shaheersystems-inc/antiflow/issues/30). Until then, install it from
> GitHub (see below). The package name and install command on this page may change when it's
> published.

## Requirements

- **A modern JavaScript runtime.** antiflow uses only standard web platform APIs:
  `structuredClone`, `crypto.randomUUID`, `AbortController` / `AbortSignal` and `setTimeout`.
  Node.js 20+, Bun, Deno and modern edge runtimes all have them.
- **[Zod](https://zod.dev) 4.** Node types declare their config with Zod schemas, so your
  code imports `zod` too. antiflow uses Zod 4 features (`z.json()`, `z.toJSONSchema()`).
- **TypeScript** is recommended but not required. The types carry each node type's config
  and ports into its handler.

## Install from GitHub

Installing from GitHub builds the package on your machine through its `prepare` script, so
it works on any supported runtime, not only those that load TypeScript directly.

```bash
npm install github:shaheersystems-inc/antiflow zod
```

Bun doesn't run install scripts for dependencies it doesn't trust, so with Bun, trust the
package once after adding it. Without this step, `antiflow` can't be imported.

```bash
bun add github:shaheersystems-inc/antiflow zod
bun pm trust antiflow
```

## Install from npm (once published)

```bash
npm install antiflow zod
# or
pnpm add antiflow zod
# or
bun add antiflow zod
```

## Entry points

```ts
// The engine, registration API, in-memory storage adapter and types
import { createEngine, defineNodeType, createInMemoryStorage } from "antiflow";

// The core control-flow nodes: opt-in, never registered for you
import { registerCoreNodes } from "antiflow/nodes/core";

// The storage adapter conformance suite, for adapter authors' tests
import { defineStorageAdapterTests } from "antiflow/testing";
```

The core package contains no node implementations. You only get the core nodes if you import
and register them. See [Core nodes](../reference/core-nodes.md).

## Next

[Run your first workflow →](quickstart.md)
