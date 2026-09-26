---
title: antiflow/testing
description: Reference for the storage adapter conformance suite.
---

# `antiflow/testing`

Test helpers for hosts and adapter authors, kept out of the core entry point.

```ts
import { defineStorageAdapterTests } from "antiflow/testing";
import type { TestRunner } from "antiflow/testing";
```

## `defineStorageAdapterTests(name, createAdapter, runner)`

```ts
function defineStorageAdapterTests(
  name: string,
  createAdapter: () => StorageAdapter | Promise<StorageAdapter>,
  runner: TestRunner,
): void;

interface TestRunner {
  describe: (name: string, body: () => void) => void;
  test: (name: string, fn: () => Promise<void>) => void;
}
```

Defines the conformance suite in your test runner, under a `describe(name, …)` block. An
adapter passes when it behaves like the in-memory reference adapter.

- `createAdapter` is called once **per test** and should return an **empty** store.
- `runner` is your test framework's `describe` and `test`. Bun's, Vitest's and Jest's all fit.
- The suite asserts on its own and throws on failure, so it doesn't depend on any assertion
  library.

```ts
import { describe, test } from "bun:test";
import { createInMemoryStorage } from "antiflow";
import { defineStorageAdapterTests } from "antiflow/testing";

defineStorageAdapterTests("in-memory adapter", () => createInMemoryStorage(), { describe, test });
```

## What it checks

**Run records**

- `getRun` returns `undefined` for a run that was never saved.
- A saved run record reads back unchanged.
- A later save replaces the whole record, including removing fields the new record lacks.
- Run records are kept apart by id.
- Mutating a record after saving it, or after reading it, doesn't change what's stored.

**Node records**

- `listNodeRecords` returns an empty array for a run without any.
- Saved node records read back unchanged.
- A later save for the same run and node replaces the whole record.
- Only the given run's node records are listed.
- Mutating a record after saving or reading it doesn't change what's stored.
- Every record is kept when many are saved at once.
- Runs and nodes whose ids run together (run `r1` + node `a:b` vs run `r1:a` + node `b`) aren't confused.

**Values**

- Every kind of JSON value round-trips in inputs and outputs.
- Returned records survive JSON serialization unchanged.

These map onto the [rules](../guides/storage-adapters.md#rules) for storage adapters.
