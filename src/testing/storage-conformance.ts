import type { JsonValue, NodeRecord, RunRecord, StorageAdapter } from "../types.ts";

/** The parts of a test runner the suite needs; Bun's, Vitest's and Jest's all fit. */
export interface TestRunner {
  describe: (name: string, body: () => void) => void;
  test: (name: string, fn: () => Promise<void>) => void;
}

/**
 * Defines the storage adapter conformance suite in the caller's test runner. Every test gets
 * a fresh adapter from `createAdapter`; an adapter passes when it behaves like the in-memory
 * reference adapter. The suite asserts on its own (it throws on failure), so it depends on
 * no particular test framework.
 *
 * ```ts
 * import { describe, test } from "vitest";
 * import { defineStorageAdapterTests } from "antiflow/testing";
 * defineStorageAdapterTests("postgres adapter", () => createPostgresAdapter(pool), { describe, test });
 * ```
 */
export function defineStorageAdapterTests(
  name: string,
  createAdapter: () => StorageAdapter | Promise<StorageAdapter>,
  { describe, test }: TestRunner,
): void {
  describe(name, () => {
    const adapterTest = (title: string, check: (adapter: StorageAdapter) => Promise<void>) =>
      test(title, async () => check(await createAdapter()));

    // ---- Run records ------------------------------------------------------

    adapterTest("returns undefined for a run record that was never saved", async (adapter) => {
      assertEqual(await adapter.getRun("missing"), undefined, "getRun of an unknown run");
    });

    adapterTest("reads back a saved run record unchanged", async (adapter) => {
      const run = sampleRun("run-1");
      await adapter.saveRun(run);
      assertEqual(await adapter.getRun("run-1"), run, "getRun after saveRun");
    });

    adapterTest("replaces the whole run record on a later save, including removed fields", async (adapter) => {
      await adapter.saveRun({ ...sampleRun("run-1"), status: "failed", completedAt: at(5) });
      const resumed = sampleRun("run-1");
      await adapter.saveRun(resumed);
      assertEqual(await adapter.getRun("run-1"), resumed, "getRun after a second saveRun without completedAt");
    });

    adapterTest("keeps run records apart by id", async (adapter) => {
      const one = sampleRun("run-1");
      const two = { ...sampleRun("run-2"), input: "other input" };
      await adapter.saveRun(one);
      await adapter.saveRun(two);
      assertEqual(await adapter.getRun("run-1"), one, "run-1");
      assertEqual(await adapter.getRun("run-2"), two, "run-2");
    });

    adapterTest("isn't affected by the caller mutating a run record after saving or reading it", async (adapter) => {
      const run = sampleRun("run-1");
      await adapter.saveRun(run);
      run.status = "cancelled";
      (run.workflowSnapshot.nodes[0]!.config as { suffix: string }).suffix = "changed";
      const read = (await adapter.getRun("run-1"))!;
      read.input = "changed";
      assertEqual(await adapter.getRun("run-1"), sampleRun("run-1"), "getRun after mutating saved and read objects");
    });

    // ---- Node records -----------------------------------------------------

    adapterTest("lists no node records for a run without any", async (adapter) => {
      assertEqual(await adapter.listNodeRecords("missing"), [], "listNodeRecords of an unknown run");
    });

    adapterTest("reads back saved node records unchanged", async (adapter) => {
      const records = sampleNodeRecords("run-1");
      for (const record of records) await adapter.saveNodeRecord(record);
      assertEqual(byNode(await adapter.listNodeRecords("run-1")), byNode(records), "listNodeRecords after saves");
    });

    adapterTest("replaces the whole node record for the same run and node on a later save", async (adapter) => {
      await adapter.saveNodeRecord({
        runId: "run-1",
        nodeId: "a",
        status: "running",
        attempt: 1,
        error: "failure 1",
        startedAt: at(0),
      });
      const final: NodeRecord = {
        runId: "run-1",
        nodeId: "a",
        status: "succeeded",
        attempt: 2,
        output: "ok",
        startedAt: at(0),
        completedAt: at(1),
      };
      await adapter.saveNodeRecord(final);
      assertEqual(await adapter.listNodeRecords("run-1"), [final], "listNodeRecords after the node record was replaced");
    });

    adapterTest("lists only the node records of the given run", async (adapter) => {
      const one = sampleNodeRecords("run-1");
      const two = sampleNodeRecords("run-2").slice(0, 1);
      for (const record of [...one, ...two]) await adapter.saveNodeRecord(record);
      assertEqual(byNode(await adapter.listNodeRecords("run-1")), byNode(one), "run-1's node records");
      assertEqual(byNode(await adapter.listNodeRecords("run-2")), byNode(two), "run-2's node records");
    });

    adapterTest("isn't affected by the caller mutating a node record after saving or reading it", async (adapter) => {
      const [record] = sampleNodeRecords("run-1");
      await adapter.saveNodeRecord(record!);
      record!.status = "failed";
      const [read] = await adapter.listNodeRecords("run-1");
      read!.attempt = 99;
      assertEqual(await adapter.listNodeRecords("run-1"), sampleNodeRecords("run-1").slice(0, 1), "after mutation");
    });

    adapterTest("keeps every node record when many are saved at once", async (adapter) => {
      const records = Array.from({ length: 25 }, (_, i): NodeRecord => ({
        runId: "run-1",
        nodeId: `node-${i}`,
        status: "pending",
        attempt: 0,
      }));
      await Promise.all(records.map((record) => adapter.saveNodeRecord(record)));
      assertEqual(byNode(await adapter.listNodeRecords("run-1")), byNode(records), "node records saved concurrently");
    });

    adapterTest("doesn't confuse runs and nodes whose ids run together", async (adapter) => {
      const one: NodeRecord = { runId: "r1", nodeId: "a:b", status: "succeeded", attempt: 1, output: "one" };
      const two: NodeRecord = { runId: "r1:a", nodeId: "b", status: "succeeded", attempt: 1, output: "two" };
      await adapter.saveNodeRecord(one);
      await adapter.saveNodeRecord(two);
      assertEqual(await adapter.listNodeRecords("r1"), [one], "run r1");
      assertEqual(await adapter.listNodeRecords("r1:a"), [two], "run r1:a");
    });

    // ---- Values -----------------------------------------------------------

    adapterTest("round-trips every kind of JSON value in inputs and outputs", async (adapter) => {
      const values: JsonValue[] = [null, true, false, 0, -1.5, 1e21, "", "ünïcødé ✓ \n\t\"quoted\"", [], {}, awkwardJson];
      for (const [i, value] of values.entries()) {
        const run = { ...sampleRun(`run-${i}`), input: value };
        await adapter.saveRun(run);
        assertEqual(await adapter.getRun(run.id), run, `run input ${JSON.stringify(value)}`);
        const record: NodeRecord = { runId: run.id, nodeId: "n", status: "succeeded", attempt: 1, output: value };
        await adapter.saveNodeRecord(record);
        assertEqual(await adapter.listNodeRecords(run.id), [record], `node output ${JSON.stringify(value)}`);
      }
    });

    adapterTest("returns records that survive JSON serialization unchanged", async (adapter) => {
      await adapter.saveRun(sampleRun("run-1"));
      for (const record of sampleNodeRecords("run-1")) await adapter.saveNodeRecord(record);
      const run = await adapter.getRun("run-1");
      assertEqual(JSON.parse(JSON.stringify(run)), run, "run record through JSON");
      const records = await adapter.listNodeRecords("run-1");
      assertEqual(JSON.parse(JSON.stringify(records)), records, "node records through JSON");
    });
  });
}

/** A timestamp `seconds` into the sample run. Timestamps are opaque strings to adapters. */
const at = (seconds: number) => `2026-01-01T00:00:0${seconds}.000Z`;

const awkwardJson: JsonValue = {
  nested: { deeply: [1, [2, [3, { four: null }]]] },
  "key with spaces": "value",
  "": "empty key",
  list: [{ a: 1 }, { b: [true, false] }],
};

function sampleRun(id: string): RunRecord {
  return {
    id,
    status: "running",
    startedAt: at(0),
    workflowSnapshot: {
      nodes: [
        {
          id: "a",
          type: "test.append@1",
          config: { suffix: "!" },
          timeoutMs: 500,
          retry: { maxAttempts: 3, backoff: "exponential", delayMs: 10 },
        },
        { id: "b", type: "test.fork@2", config: { cases: ["x", "y"], nested: { on: true } } },
      ],
      edges: [{ from: { node: "a", port: "out" }, to: { node: "b", port: "in" } }],
    },
    input: { text: "hello", count: 2 },
  };
}

function sampleNodeRecords(runId: string): NodeRecord[] {
  return [
    {
      runId,
      nodeId: "a",
      status: "succeeded",
      attempt: 2,
      output: { text: "hello!" },
      startedAt: at(0),
      completedAt: at(1),
    },
    {
      runId,
      nodeId: "b",
      status: "succeeded",
      attempt: 1,
      outputsByPort: { x: [1, 2], y: null },
      startedAt: at(1),
      completedAt: at(2),
    },
    { runId, nodeId: "c", status: "failed", attempt: 1, error: "boom", startedAt: at(2), completedAt: at(3) },
    { runId, nodeId: "d", status: "pending", attempt: 0 },
  ];
}

/** Node records keyed by node id, since adapters may list them in any order. */
const byNode = (records: NodeRecord[]) => Object.fromEntries(records.map((r) => [r.nodeId, r]));

/**
 * Throws unless `actual` and `expected` are structurally equal. A property set to `undefined`
 * counts as absent, since adapters that store JSON can't tell the two apart.
 */
function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const definedKeys = (o: object) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k]) => k).sort();
  const keys = definedKeys(a);
  return (
    deepEqual(keys, definedKeys(b)) &&
    keys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}
