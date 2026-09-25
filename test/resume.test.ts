import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createEngine, createInMemoryStorage, defineNodeType, ResumeError } from "../src/index.ts";
import type { EngineEvent, StorageAdapter, WorkflowDefinition } from "../src/index.ts";
import { append, edge, node, sleep, upper } from "./fixtures.ts";

/**
 * Fake node types whose behaviour a test can switch while runs are in flight: `test.step`
 * appends its node id to its input, and hangs, throws or succeeds per `mode`; every call is
 * recorded.
 */
function steps() {
  const calls: string[] = [];
  const mode: Record<string, "ok" | "hang" | "fail"> = {};
  const nodeType = defineNodeType({
    type: "test.step",
    version: 1,
    inputs: ["in"],
    outputs: ["out"],
    config: z.object({}),
    display: { name: "Step" },
    handler: async (input, _config, { nodeId }) => {
      calls.push(nodeId);
      if (mode[nodeId] === "hang") await new Promise(() => {});
      if (mode[nodeId] === "fail") throw new Error(`${nodeId} failed`);
      return `${input.in}>${nodeId}`;
    },
  });
  return { nodeType, calls, mode };
}

/** An engine over `storage` with `upper` and a fresh `test.step`. */
function engineOver(storage: StorageAdapter) {
  const engine = createEngine({ storage });
  const step = steps();
  engine.register(upper);
  engine.register(step.nodeType);
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, events, ...step };
}

// start → b → c
const chain: WorkflowDefinition = {
  nodes: [node("start", "test.upper@1"), node("b", "test.step@1"), node("c", "test.step@1")],
  edges: [edge("start", "b"), edge("b", "c")],
};

const statuses = async (storage: StorageAdapter, runId: string) =>
  Object.fromEntries((await storage.listNodeRecords(runId)).map((r) => [r.nodeId, r.status]));

describe("snapshot", () => {
  test("changing the workflow definition after execute() has no effect on the run", async () => {
    const storage = createInMemoryStorage();
    const engine = createEngine({ storage });
    engine.register(append);
    engine.register(
      defineNodeType({
        type: "test.slow",
        version: 1,
        inputs: [],
        outputs: ["out"],
        config: z.object({}),
        display: { name: "Slow" },
        handler: async (input) => {
          await sleep(20);
          return input;
        },
      }),
    );
    const workflow: WorkflowDefinition = {
      nodes: [node("a", "test.slow@1"), node("b", "test.append@1", { suffix: "!" })],
      edges: [edge("a", "b")],
    };

    const run = await engine.execute(workflow, "hi");
    (workflow.nodes[1]!.config as { suffix: string }).suffix = "?";
    workflow.nodes.push(node("c", "test.append@1", { suffix: "." }));
    workflow.edges.push(edge("b", "c"));
    await run.finished;

    const records = await storage.listNodeRecords(run.id);
    expect(records.map((r) => [r.nodeId, r.output])).toEqual([
      ["a", "hi"],
      ["b", "hi!"],
    ]);
    expect((await storage.getRun(run.id))?.workflowSnapshot.nodes).toHaveLength(2);
  });
});

describe("resume", () => {
  test("a new engine over the same storage resumes an interrupted run to completion", async () => {
    const storage = createInMemoryStorage();
    const first = engineOver(storage);
    first.mode.b = "hang";
    const run = await first.engine.execute(chain, "go");
    await sleep(10);
    // The first engine "crashes" with b in flight.
    expect(await statuses(storage, run.id)).toEqual({ start: "succeeded", b: "running", c: "pending" });

    const second = engineOver(storage);
    const resumed = await second.engine.resume(run.id);
    const finished = await resumed.finished;

    expect(resumed.id).toBe(run.id);
    expect(finished.status).toBe("completed");
    // b re-runs (at-least-once); start, already succeeded, doesn't.
    expect(second.calls).toEqual(["b", "c"]);
    const records = Object.fromEntries((await storage.listNodeRecords(run.id)).map((r) => [r.nodeId, r]));
    expect(records.c).toMatchObject({ status: "succeeded", output: "GO>b>c" });
    expect(second.events.map((e) => e.type)).toEqual([
      "node:start",
      "node:succeeded",
      "node:start",
      "node:succeeded",
      "run:completed",
    ]);
  });

  test("retries a failed node, then runs its downstream and updates the run's final status", async () => {
    const storage = createInMemoryStorage();
    const { engine, calls, mode } = engineOver(storage);
    mode.b = "fail";
    const run = await engine.execute(chain, "go");
    expect((await run.finished).status).toBe("failed");
    expect(await statuses(storage, run.id)).toEqual({ start: "succeeded", b: "failed", c: "pending" });

    mode.b = "ok";
    const finished = await (await engine.resume(run.id)).finished;

    expect(finished.status).toBe("completed");
    expect(calls).toEqual(["b", "b", "c"]);
    expect(await statuses(storage, run.id)).toEqual({ start: "succeeded", b: "succeeded", c: "succeeded" });
    const record = await storage.getRun(run.id);
    expect(record?.status).toBe("completed");
    expect(Date.parse(record!.completedAt!)).toBeGreaterThanOrEqual(Date.parse(record!.startedAt));
  });

  test("a retried node gets a fresh set of attempts", async () => {
    const storage = createInMemoryStorage();
    const { engine, mode } = engineOver(storage);
    mode.b = "fail";
    const workflow: WorkflowDefinition = {
      ...chain,
      nodes: chain.nodes.map((n) => (n.id === "b" ? { ...n, retry: { maxAttempts: 2, delayMs: 0 } } : n)),
    };
    const run = await engine.execute(workflow, "go");
    await run.finished;
    const failed = (await storage.listNodeRecords(run.id)).find((r) => r.nodeId === "b");
    expect(failed).toMatchObject({ status: "failed", attempt: 2 });

    mode.b = "ok";
    await (await engine.resume(run.id)).finished;

    const retried = (await storage.listNodeRecords(run.id)).find((r) => r.nodeId === "b");
    expect(retried).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(retried).not.toHaveProperty("error");
  });

  test("keeps skipped nodes skipped", async () => {
    const storage = createInMemoryStorage();
    const { engine, calls, mode } = engineOver(storage);
    engine.register(
      defineNodeType({
        type: "test.fork",
        version: 1,
        inputs: [],
        outputs: ["yes", "no"],
        config: z.object({}),
        display: { name: "Fork" },
        handler: async (input) => ({ yes: input }),
      }),
    );
    mode.b = "fail";
    const run = await engine.execute(
      {
        nodes: [node("f", "test.fork@1"), node("b", "test.step@1"), node("n", "test.step@1")],
        edges: [edge("f", "b", { out: "yes" }), edge("f", "n", { out: "no" })],
      },
      "go",
    );
    await run.finished;

    mode.b = "ok";
    await (await engine.resume(run.id)).finished;

    expect(calls).toEqual(["b", "b"]);
    expect(await statuses(storage, run.id)).toEqual({ f: "succeeded", b: "succeeded", n: "skipped" });
  });

  test("resumes against the snapshot, not the node types' current registrations of other versions", async () => {
    const storage = createInMemoryStorage();
    const first = engineOver(storage);
    first.mode.b = "fail";
    const run = await first.engine.execute(chain, "go");
    await run.finished;

    // A second engine registers only a newer version of test.step.
    const second = createEngine({ storage });
    second.register(upper);
    second.register({ ...steps().nodeType, version: 2 });

    const error = await second.resume(run.id).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ResumeError);
    expect((error as ResumeError).unregistered).toEqual([
      { nodeId: "b", type: "test.step@1" },
      { nodeId: "c", type: "test.step@1" },
    ]);
    expect((error as Error).message).toMatch(/"b".*test\.step@1/s);
    expect((await storage.getRun(run.id))?.status).toBe("failed");
  });

  test("refuses to resume a run that doesn't exist, has completed, or is still running here", async () => {
    const storage = createInMemoryStorage();
    const { engine, mode } = engineOver(storage);

    await expect(engine.resume("no-such-run")).rejects.toThrow(/no-such-run/);

    const done = await engine.execute(chain, "go");
    await done.finished;
    await expect(engine.resume(done.id)).rejects.toThrow(/completed/);

    mode.b = "hang";
    const hanging = await engine.execute(chain, "go");
    await expect(engine.resume(hanging.id)).rejects.toThrow(/already running/);
  });
});
