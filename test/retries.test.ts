import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineNodeType } from "../src/index.ts";
import type { EngineOptions, JsonValue, WorkflowNode } from "../src/index.ts";
import { harness, sleep } from "./fixtures.ts";

/**
 * Fake node type that fails its first `config.failures` attempts, then outputs the input.
 * Records the time and input of every attempt.
 */
function flaky() {
  const attempts: { attempt: number; at: number; input: JsonValue }[] = [];
  const nodeType = defineNodeType({
    type: "test.flaky",
    version: 1,
    inputs: [],
    outputs: ["out"],
    config: z.object({ failures: z.number() }),
    display: { name: "Flaky" },
    handler: async (input, config, context) => {
      attempts.push({ attempt: context.attempt, at: performance.now(), input });
      if (context.attempt <= config.failures) throw new Error(`failure ${context.attempt}`);
      return input;
    },
  });
  return { nodeType, attempts };
}

/** Fake node type that waits `config.ms`, or until its signal aborts; records aborts. */
function waiter() {
  const aborted: number[] = [];
  const nodeType = defineNodeType({
    type: "test.wait",
    version: 1,
    inputs: [],
    outputs: ["out"],
    config: z.object({ ms: z.number(), fastAfter: z.number().optional() }),
    display: { name: "Wait" },
    handler: async (_input, config, { signal, attempt }) => {
      // Optionally become fast from a given attempt on, so a retry can beat the timeout.
      const ms = config.fastAfter !== undefined && attempt >= config.fastAfter ? 0 : config.ms;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            aborted.push(attempt);
            resolve();
          },
          { once: true },
        );
      });
      if (signal.aborted) throw signal.reason;
      return "done";
    },
  });
  return { nodeType, aborted };
}

/** Runs a workflow of just `node`, returning the run, the node's record and the run's events. */
function setup(options: EngineOptions = {}) {
  const { engine, storage, execute: executeWorkflow } = harness(options);
  const execute = async (node: WorkflowNode, input: JsonValue = "in") => {
    const { run, records, events } = await executeWorkflow({ nodes: [node], edges: [] }, input);
    return { run, record: records[node.id]!, events };
  };
  return { engine, storage, execute };
}

const STUBBORN_MS = 400;

/** Fake node type that ignores its signal and takes STUBBORN_MS. */
const stubborn = defineNodeType({
  type: "test.stubborn",
  version: 1,
  inputs: [],
  outputs: ["out"],
  config: z.object({}),
  display: { name: "Stubborn" },
  handler: async () => {
    await sleep(STUBBORN_MS);
    return "late";
  },
});

const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]!);

describe("timeouts", () => {
  test("a handler exceeding timeoutMs has its signal aborted and fails with a timeout error", async () => {
    const { engine, execute } = setup();
    const { nodeType, aborted } = waiter();
    engine.register(nodeType);

    const started = performance.now();
    const { run, record } = await execute({ id: "w", type: "test.wait@1", config: { ms: 1000 }, timeoutMs: 20 });

    expect(performance.now() - started).toBeLessThan(500);
    expect(aborted).toEqual([1]);
    expect(record).toMatchObject({ status: "failed", attempt: 1, error: expect.stringMatching(/timed out after 20ms/) });
    expect(run.status).toBe("failed");
  });

  test("fails a timed-out attempt at once even if the handler ignores its signal", async () => {
    const { engine, execute } = setup();
    engine.register(stubborn);

    const started = performance.now();
    const { record } = await execute({ id: "s", type: "test.stubborn@1", config: {}, timeoutMs: 20 });

    expect(performance.now() - started).toBeLessThan(250);
    expect(record).toMatchObject({ status: "failed", error: expect.stringMatching(/timed out/) });
  });

  test("a timed-out handler that ignores its signal keeps its concurrency slot until it settles", async () => {
    const { engine, execute } = setup({ concurrency: { global: 1 } });
    engine.register(stubborn);
    const { nodeType, attempts } = flaky();
    engine.register(nodeType);

    const started = performance.now();
    const [, second] = await Promise.all([
      execute({ id: "s", type: "test.stubborn@1", config: {}, timeoutMs: 20 }),
      (async () => {
        await sleep(5);
        return execute({ id: "f", type: "test.flaky@1", config: { failures: 0 } });
      })(),
    ]);

    expect(second.record.status).toBe("succeeded");
    expect(attempts[0]!.at - started).toBeGreaterThanOrEqual(STUBBORN_MS - 5);
  });

  test("without timeoutMs there is no timeout", async () => {
    const { engine, execute } = setup();
    const { nodeType, aborted } = waiter();
    engine.register(nodeType);

    const { record } = await execute({ id: "w", type: "test.wait@1", config: { ms: 50 } });

    expect(record).toMatchObject({ status: "succeeded", output: "done" });
    expect(aborted).toEqual([]);
  });
});

describe("retries", () => {
  test("a node that fails then succeeds within maxAttempts ends succeeded with its final attempt", async () => {
    const { engine, execute } = setup();
    const { nodeType, attempts } = flaky();
    engine.register(nodeType);

    const { run, record, events } = await execute({
      id: "f",
      type: "test.flaky@1",
      config: { failures: 2 },
      retry: { maxAttempts: 3, backoff: "fixed", delayMs: 0 },
    });

    expect(record).toMatchObject({ status: "succeeded", attempt: 3, output: "in" });
    expect(record).not.toHaveProperty("error");
    expect(run.status).toBe("completed");
    // Every attempt starts from scratch with the same input.
    expect(attempts.map((a) => [a.attempt, a.input])).toEqual([
      [1, "in"],
      [2, "in"],
      [3, "in"],
    ]);
    expect(events.map((e) => e.type)).toEqual(["node:start", "node:start", "node:start", "node:succeeded", "run:completed"]);
    expect(events.flatMap((e) => (e.type === "node:start" ? [e.attempt] : []))).toEqual([1, 2, 3]);
  });

  test("a node that fails every attempt ends failed after exactly maxAttempts attempts", async () => {
    const { engine, execute } = setup();
    const { nodeType, attempts } = flaky();
    engine.register(nodeType);

    const { run, record, events } = await execute({
      id: "f",
      type: "test.flaky@1",
      config: { failures: 10 },
      retry: { maxAttempts: 3, backoff: "fixed", delayMs: 0 },
    });

    expect(attempts).toHaveLength(3);
    expect(record).toMatchObject({ status: "failed", attempt: 3, error: "failure 3" });
    expect(events.filter((e) => e.type === "node:failed")).toEqual([
      { type: "node:failed", runId: run.id, nodeId: "f", attempt: 3, error: "failure 3" },
    ]);
  });

  test("without a retry policy a node gets one attempt", async () => {
    const { engine, execute } = setup();
    const { nodeType, attempts } = flaky();
    engine.register(nodeType);

    const { record } = await execute({ id: "f", type: "test.flaky@1", config: { failures: 1 } });

    expect(attempts).toHaveLength(1);
    expect(record).toMatchObject({ status: "failed", attempt: 1 });
  });

  test("a timeout counts against maxAttempts like a thrown error", async () => {
    const { engine, execute } = setup();
    const { nodeType, aborted } = waiter();
    engine.register(nodeType);

    const { record } = await execute({
      id: "w",
      type: "test.wait@1",
      config: { ms: 1000, fastAfter: 3 },
      timeoutMs: 20,
      retry: { maxAttempts: 3, backoff: "fixed", delayMs: 0 },
    });

    expect(aborted).toEqual([1, 2]);
    expect(record).toMatchObject({ status: "succeeded", attempt: 3, output: "done" });
  });

  test("keeps the record running between attempts, with the latest attempt", async () => {
    const { engine, storage } = setup();
    const { nodeType } = flaky();
    engine.register(nodeType);

    const run = await engine.execute(
      {
        nodes: [{ id: "f", type: "test.flaky@1", config: { failures: 1 }, retry: { maxAttempts: 2, backoff: "fixed", delayMs: 150 } }],
        edges: [],
      },
      "in",
    );
    await sleep(40);
    const [between] = await storage.listNodeRecords(run.id);
    await run.finished;

    expect(between).toMatchObject({ status: "running", attempt: 1, error: "failure 1" });
  });
});

describe("backoff", () => {
  const cases: [string, unknown, number[]][] = [
    ["fixed", { backoff: "fixed", delayMs: 30 }, [30, 30, 30]],
    ["exponential", { backoff: "exponential", delayMs: 15 }, [15, 30, 60]],
    ["a custom function", { backoff: (attempt: number) => attempt * 20 }, [20, 40, 60]],
  ];
  test.each(cases)("%s backoff waits the expected delay between attempts", async (_label, policy, expected) => {
    const { engine, execute } = setup();
    const { nodeType, attempts } = flaky();
    engine.register(nodeType);

    await execute({
      id: "f",
      type: "test.flaky@1",
      config: { failures: 3 },
      retry: { maxAttempts: 4, ...(policy as object) } as never,
    });

    const actual = gaps(attempts.map((a) => a.at));
    expect(actual).toHaveLength(3);
    actual.forEach((gap, i) => {
      expect(gap).toBeGreaterThanOrEqual(expected[i]! - 2);
      expect(gap).toBeLessThan(expected[i]! + 100);
    });
  });

  test("the custom backoff function receives the number of the attempt that failed", async () => {
    const { engine, execute } = setup();
    const { nodeType } = flaky();
    engine.register(nodeType);
    const seen: number[] = [];

    await execute({
      id: "f",
      type: "test.flaky@1",
      config: { failures: 2 },
      retry: {
        maxAttempts: 3,
        backoff: (attempt) => {
          seen.push(attempt);
          return 0;
        },
      },
    });

    expect(seen).toEqual([1, 2]);
  });

  test("a custom backoff returning an unusable delay fails the node", async () => {
    const { engine, execute } = setup();
    const { nodeType, attempts } = flaky();
    engine.register(nodeType);

    const { record } = await execute({
      id: "f",
      type: "test.flaky@1",
      config: { failures: 5 },
      retry: { maxAttempts: 3, backoff: () => Number.POSITIVE_INFINITY },
    });

    expect(attempts).toHaveLength(1);
    expect(record).toMatchObject({ status: "failed", attempt: 1, error: expect.stringMatching(/backoff returned Infinity/) });
  });
});

describe("persisting retry policies", () => {
  test("the persisted snapshot keeps the retry policy but not a custom backoff function", async () => {
    const { engine, storage } = setup();
    engine.register(flaky().nodeType);

    const run = await engine.execute(
      {
        nodes: [{ id: "f", type: "test.flaky@1", config: { failures: 1 }, timeoutMs: 500, retry: { maxAttempts: 2, backoff: () => 0 } }],
        edges: [],
      },
      null,
    );
    expect((await run.finished).status).toBe("completed");

    const [persisted] = (await storage.getRun(run.id))!.workflowSnapshot.nodes;
    expect(persisted).toEqual({ id: "f", type: "test.flaky@1", config: { failures: 1 }, timeoutMs: 500, retry: { maxAttempts: 2 } });
  });
});

describe("validation of timeouts and retry policies", () => {
  const invalid: [string, Partial<WorkflowNode>][] = [
    ["a zero timeout", { timeoutMs: 0 }],
    ["a non-numeric timeout", { timeoutMs: "fast" as never }],
    ["maxAttempts below 1", { retry: { maxAttempts: 0, backoff: "fixed" } }],
    ["a fractional maxAttempts", { retry: { maxAttempts: 1.5, backoff: "fixed" } }],
    ["an unknown backoff", { retry: { maxAttempts: 2, backoff: "linear" as never } }],
    ["a negative delay", { retry: { maxAttempts: 2, backoff: "fixed", delayMs: -1 } }],
  ];
  test.each(invalid)("rejects %s", async (_label, options) => {
    const { engine } = setup();
    engine.register(flaky().nodeType);

    await expect(
      engine.execute({ nodes: [{ id: "f", type: "test.flaky@1", config: { failures: 0 }, ...options }], edges: [] }, null),
    ).rejects.toMatchObject({ issues: [{ nodeId: "f", code: expect.stringMatching(/^invalid-(timeout|retry-policy)$/) }] });
  });
});
