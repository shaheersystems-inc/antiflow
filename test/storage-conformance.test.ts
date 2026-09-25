import { describe, expect, test } from "bun:test";
import { createInMemoryStorage } from "../src/index.ts";
import type { NodeRecord, RunRecord, StorageAdapter } from "../src/index.ts";
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
      const all: NodeRecord[] = [];
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
      const runs = new Map<string, RunRecord>();
      const inner = createInMemoryStorage();
      return {
        ...inner,
        saveRun: async (run) => void runs.set(run.id, run),
        getRun: async (id) => runs.get(id),
      };
    };
    expect(await failures(aliasing)).not.toEqual([]);
  });

  test("catches an adapter that loses concurrent saves", async () => {
    const racy = (): StorageAdapter => {
      // Stores each run's node records as one blob, updated read-modify-write.
      const blobs = new Map<string, string>();
      return {
        ...createInMemoryStorage(),
        saveNodeRecord: async (record) => {
          const blob = JSON.parse(blobs.get(record.runId) ?? "{}");
          await new Promise((resolve) => setTimeout(resolve, 0));
          blob[record.nodeId] = record;
          blobs.set(record.runId, JSON.stringify(blob));
        },
        listNodeRecords: async (runId) => Object.values(JSON.parse(blobs.get(runId) ?? "{}")),
      };
    };
    expect(await failures(racy)).toContainEqual(expect.stringMatching(/at once/));
  });

  test("catches an adapter that joins ids into ambiguous keys", async () => {
    const joined = (): StorageAdapter => {
      const records = new Map<string, NodeRecord>();
      return {
        ...createInMemoryStorage(),
        saveNodeRecord: async (record) => void records.set(`${record.runId}:${record.nodeId}`, structuredClone(record)),
        listNodeRecords: async (runId) =>
          [...records].filter(([key]) => key.startsWith(`${runId}:`)).map(([, r]) => structuredClone(r)),
      };
    };
    expect(await failures(joined)).toContainEqual(expect.stringMatching(/run together/));
  });
});
