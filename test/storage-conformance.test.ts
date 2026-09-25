import { describe, expect, test } from "bun:test";
import { createInMemoryStorage } from "../src/index.ts";
import type { StorageAdapter } from "../src/index.ts";
import { defineStorageAdapterTests } from "../src/testing/index.ts";

defineStorageAdapterTests("in-memory storage adapter", () => createInMemoryStorage(), { describe, test });

describe("storage adapter conformance suite", () => {
  /** Collects the suite's tests without a test runner, so they can be run by hand. */
  function collect(factory: () => StorageAdapter | Promise<StorageAdapter>) {
    const tests: { name: string; fn: () => Promise<void> }[] = [];
    defineStorageAdapterTests("adapter", factory, {
      describe: (_name, body) => body(),
      test: (name, fn) => void tests.push({ name, fn: async () => fn() }),
    });
    return tests;
  }

  async function failures(factory: () => StorageAdapter) {
    const failed: string[] = [];
    for (const { name, fn } of collect(factory)) {
      await fn().catch(() => failed.push(name));
    }
    return failed;
  }

  test("covers run records and node records", () => {
    const names = collect(createInMemoryStorage).map((t) => t.name).join("\n");
    expect(names).toMatch(/run record/);
    expect(names).toMatch(/node record/);
    expect(collect(createInMemoryStorage).length).toBeGreaterThanOrEqual(8);
  });

  test("passes for the in-memory adapter", async () => {
    expect(await failures(createInMemoryStorage)).toEqual([]);
  });

  test("catches an adapter that loses fields", async () => {
    const lossy = (): StorageAdapter => {
      const inner = createInMemoryStorage();
      return { ...inner, saveRun: (run) => inner.saveRun({ ...run, input: null }) };
    };
    expect(await failures(lossy)).not.toEqual([]);
  });

  test("catches an adapter that merges updates instead of replacing records", async () => {
    const merging = (): StorageAdapter => {
      const inner = createInMemoryStorage();
      return {
        ...inner,
        saveNodeRecord: async (record) => {
          const existing = (await inner.listNodeRecords(record.runId)).find((r) => r.nodeId === record.nodeId);
          await inner.saveNodeRecord({ ...existing, ...record });
        },
      };
    };
    expect(await failures(merging)).toContainEqual(expect.stringMatching(/replaces/));
  });

  test("catches an adapter that mixes up runs", async () => {
    const leaky = (): StorageAdapter => {
      const inner = createInMemoryStorage();
      const all: Parameters<StorageAdapter["saveNodeRecord"]>[0][] = [];
      return {
        ...inner,
        saveNodeRecord: async (record) => {
          all.push(record);
          await inner.saveNodeRecord(record);
        },
        listNodeRecords: async () => structuredClone(all),
      };
    };
    expect(await failures(leaky)).not.toEqual([]);
  });

  test("catches an adapter whose stored state changes when the caller mutates a saved object", async () => {
    const aliasing = (): StorageAdapter => {
      const runs = new Map<string, Parameters<StorageAdapter["saveRun"]>[0]>();
      const inner = createInMemoryStorage();
      return {
        ...inner,
        saveRun: async (run) => void runs.set(run.id, run),
        getRun: async (id) => runs.get(id),
      };
    };
    expect(await failures(aliasing)).not.toEqual([]);
  });
});
