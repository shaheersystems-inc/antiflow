import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createEngine, createInMemoryStorage, defineNodeType } from "../src/index.ts";
import type { EngineEvent } from "../src/index.ts";
import { append, edge, upper } from "./fixtures.ts";

describe("execute", () => {
  test("runs a single-node workflow on the trigger input and completes the run", async () => {
    const storage = createInMemoryStorage();
    const engine = createEngine({ storage });
    engine.register(upper);

    const run = await engine.execute(
      { nodes: [{ id: "a", type: "test.upper@1", config: {} }], edges: [] },
      "hello",
    );
    await run.finished;

    expect((await storage.getRun(run.id))?.status).toBe("completed");
    const [node] = await storage.listNodeRecords(run.id);
    expect(node).toMatchObject({ nodeId: "a", status: "succeeded", attempt: 1, output: "HELLO" });
  });

  test("passes each node's output along edges to the next node in dependency order", async () => {
    const storage = createInMemoryStorage();
    const engine = createEngine({ storage });
    engine.register(upper);
    engine.register(append);

    // Listed out of order on purpose: execution order comes from the edges.
    const run = await engine.execute(
      {
        nodes: [
          { id: "c", type: "test.append@1", config: { suffix: "!" } },
          { id: "a", type: "test.upper@1", config: {} },
          { id: "b", type: "test.append@1", config: { suffix: " world" } },
        ],
        edges: [edge("a", "b"), edge("b", "c")],
      },
      "hello",
    );
    await run.finished;

    const outputs = Object.fromEntries(
      (await storage.listNodeRecords(run.id)).map((r) => [r.nodeId, r.output]),
    );
    expect(outputs).toEqual({ a: "HELLO", b: "HELLO world", c: "HELLO world!" });
    expect((await storage.getRun(run.id))?.status).toBe("completed");
  });

  test("gives the handler its parsed config and a context tagged with the run and node", async () => {
    const logged: { message: string; fields?: Record<string, unknown> }[] = [];
    const sink = (message: string, fields?: Record<string, unknown>) => void logged.push({ message, fields });
    const engine = createEngine({ logger: { debug: sink, info: sink, warn: sink, error: sink } });

    let seen: { config: unknown; runId: string; nodeId: string; attempt: number; aborted: boolean } | undefined;
    engine.register(
      defineNodeType({
        type: "test.inspect",
        version: 1,
        inputs: [],
        outputs: ["out"],
        config: z.object({ greeting: z.string().default("hi") }),
        display: { name: "Inspect" },
        handler: async (_input, config, context) => {
          const { runId, nodeId, attempt, signal } = context;
          seen = { config, runId, nodeId, attempt, aborted: signal.aborted };
          context.logger.info("handled", { size: 3 });
          return null;
        },
      }),
    );

    const run = await engine.execute(
      { nodes: [{ id: "n1", type: "test.inspect@1", config: {} }], edges: [] },
      null,
    );
    await run.finished;

    expect(seen).toEqual({ config: { greeting: "hi" }, runId: run.id, nodeId: "n1", attempt: 1, aborted: false });
    expect(logged).toEqual([
      { message: "handled", fields: { runId: run.id, nodeId: "n1", attempt: 1, size: 3 } },
    ]);
  });

  test("emits node and run lifecycle events to subscribers, in order", async () => {
    const engine = createEngine();
    engine.register(upper);
    engine.register(append);
    const events: EngineEvent[] = [];
    engine.subscribe((event) => events.push(event));

    const run = await engine.execute(
      {
        nodes: [
          { id: "a", type: "test.upper@1", config: {} },
          { id: "b", type: "test.append@1", config: { suffix: "!" } },
        ],
        edges: [edge("a", "b")],
      },
      "hi",
    );
    await run.finished;

    expect(events).toEqual([
      { type: "node:start", runId: run.id, nodeId: "a", attempt: 1 },
      { type: "node:succeeded", runId: run.id, nodeId: "a", attempt: 1 },
      { type: "node:start", runId: run.id, nodeId: "b", attempt: 1 },
      { type: "node:succeeded", runId: run.id, nodeId: "b", attempt: 1 },
      { type: "run:completed", runId: run.id },
    ]);
  });

  test("persists a run record and a node record with snapshot, input and timestamps", async () => {
    const storage = createInMemoryStorage();
    const engine = createEngine({ storage });
    engine.register(upper);
    const workflow = { nodes: [{ id: "a", type: "test.upper@1", config: {} }], edges: [] };

    const run = await engine.execute(workflow, "hi");
    await run.finished;

    const record = await storage.getRun(run.id);
    expect(record).toMatchObject({ id: run.id, status: "completed", workflowSnapshot: workflow, input: "hi" });
    expect(Date.parse(record!.completedAt!)).toBeGreaterThanOrEqual(Date.parse(record!.startedAt));

    const [node] = await storage.listNodeRecords(run.id);
    expect(node).toMatchObject({ runId: run.id, nodeId: "a", status: "succeeded", attempt: 1, output: "HI" });
    expect(Date.parse(node!.completedAt!)).toBeGreaterThanOrEqual(Date.parse(node!.startedAt!));
  });

  test("uses in-memory storage by default and resolves `finished` with the final run record", async () => {
    const engine = createEngine();
    engine.register(upper);

    const run = await engine.execute(
      { nodes: [{ id: "a", type: "test.upper@1", config: {} }], edges: [] },
      "hi",
    );

    expect(await run.finished).toMatchObject({ id: run.id, status: "completed", input: "hi" });
  });

  test("stops delivering events after unsubscribing", async () => {
    const engine = createEngine();
    engine.register(upper);
    const events: EngineEvent[] = [];
    const unsubscribe = engine.subscribe((event) => events.push(event));
    unsubscribe();

    const run = await engine.execute(
      { nodes: [{ id: "a", type: "test.upper@1", config: {} }], edges: [] },
      "hi",
    );
    await run.finished;

    expect(events).toEqual([]);
  });
});
