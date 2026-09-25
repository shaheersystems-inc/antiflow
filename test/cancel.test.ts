import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineNodeType } from "../src/index.ts";
import type { EngineEvent, EngineOptions, NodeRecord } from "../src/index.ts";
import { edge, harness, node, relay, sleep } from "./fixtures.ts";

/**
 * Fake node type that runs for `config.ms`. If its signal aborts it records that and settles
 * `config.settleMs` later, by throwing unless `config.ignoreAbort`.
 */
function worker() {
  const aborted: string[] = [];
  const started: string[] = [];
  const nodeType = defineNodeType({
    type: "test.work",
    version: 1,
    inputs: [],
    outputs: ["out"],
    config: z.object({ ms: z.number(), settleMs: z.number().default(0), ignoreAbort: z.boolean().default(false) }),
    display: { name: "Work" },
    handler: async (_input, config, { signal, nodeId }) => {
      started.push(nodeId);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, config.ms);
        signal.addEventListener("abort", () => {
          aborted.push(nodeId);
          if (config.ignoreAbort) return;
          clearTimeout(timer);
          setTimeout(resolve, config.settleMs);
        });
      });
      if (signal.aborted && !config.ignoreAbort) throw new Error("aborted");
      return nodeId;
    },
  });
  return { nodeType, aborted, started };
}

function setup(options: EngineOptions = {}) {
  const { engine, storage } = harness(options);
  const work = worker();
  engine.register(work.nodeType);
  engine.register(relay);
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  const records = async (runId: string) =>
    Object.fromEntries((await storage.listNodeRecords(runId)).map((r) => [r.nodeId, r])) as Record<string, NodeRecord>;
  return { engine, storage, work, events, records };
}

describe("cancel", () => {
  test("sets the run to cancelling at once, and to cancelled once in-flight handlers settle", async () => {
    const { engine, storage, work, events } = setup();
    const run = await engine.execute({ nodes: [node("w", "test.work@1", { ms: 1000, settleMs: 30 })], edges: [] }, null);
    await sleep(5);

    const cancelledAt = performance.now();
    await engine.cancel(run.id);
    expect((await storage.getRun(run.id))?.status).toBe("cancelling");

    const finished = await run.finished;
    expect(performance.now() - cancelledAt).toBeGreaterThanOrEqual(25);
    expect(finished.status).toBe("cancelled");
    expect(finished.completedAt).toBeDefined();
    expect((await storage.getRun(run.id))?.status).toBe("cancelled");
    expect(work.aborted).toEqual(["w"]);
    expect(events.filter((e) => e.type.startsWith("run:"))).toEqual([{ type: "run:cancelled", runId: run.id }]);
  });

  test("waits for an in-flight handler that ignores its signal, whatever its outcome", async () => {
    const { engine, work, events, records } = setup();
    const run = await engine.execute(
      { nodes: [node("w", "test.work@1", { ms: 40, ignoreAbort: true })], edges: [] },
      null,
    );
    await sleep(5);

    await engine.cancel(run.id);
    const finished = await run.finished;

    expect(work.aborted).toEqual(["w"]);
    expect(finished.status).toBe("cancelled");
    expect((await records(run.id)).w).toMatchObject({ status: "succeeded", output: "w" });
    const types = events.map((e) => e.type);
    expect(types.indexOf("node:succeeded")).toBeLessThan(types.indexOf("run:cancelled"));
  });

  test("starts no new node after cancel, and gives nodes left unrun their own status", async () => {
    const { engine, work, events, records } = setup();
    // a → b → c; b and c never get to run.
    const run = await engine.execute(
      {
        nodes: [node("a", "test.work@1", { ms: 30, ignoreAbort: true }), node("b", "test.relay@1", { ms: 0 }), node("c", "test.relay@1", { ms: 0 })],
        edges: [edge("a", "b"), edge("b", "c")],
      },
      null,
    );
    await sleep(5);

    await engine.cancel(run.id);
    await run.finished;

    const byNode = await records(run.id);
    expect(byNode.a?.status).toBe("succeeded");
    expect(byNode.b).toMatchObject({ status: "cancelled", attempt: 0 });
    expect(byNode.c).toMatchObject({ status: "cancelled", attempt: 0 });
    expect(work.started).toEqual(["a"]);
    expect(events.filter((e) => e.type === "node:start").map((e) => "nodeId" in e && e.nodeId)).toEqual(["a"]);
  });

  test("an in-flight node that fails because it was aborted is recorded as cancelled", async () => {
    const { engine, records } = setup();
    const run = await engine.execute({ nodes: [node("w", "test.work@1", { ms: 1000 })], edges: [] }, null);
    await sleep(5);

    await engine.cancel(run.id);
    await run.finished;

    expect((await records(run.id)).w).toMatchObject({ status: "cancelled", attempt: 1, error: "aborted" });
  });

  test("nodes waiting for a concurrency slot never start", async () => {
    const { engine, work, records } = setup({ concurrency: { global: 1 } });
    const run = await engine.execute(
      {
        nodes: [node("first", "test.work@1", { ms: 1000 }), node("second", "test.work@1", { ms: 1000 })],
        edges: [],
      },
      null,
    );
    await sleep(5);

    await engine.cancel(run.id);
    await run.finished;

    expect(work.started).toEqual(["first"]);
    expect((await records(run.id)).second).toMatchObject({ status: "cancelled", attempt: 0 });
  });

  test("interrupts a retry backoff and makes no further attempts", async () => {
    const { engine, records } = setup();
    let attempts = 0;
    engine.register(
      defineNodeType({
        type: "test.flaky",
        version: 1,
        inputs: [],
        outputs: ["out"],
        config: z.object({}),
        display: { name: "Flaky" },
        handler: async () => {
          attempts++;
          throw new Error("nope");
        },
      }),
    );
    const run = await engine.execute(
      { nodes: [{ ...node("f", "test.flaky@1"), retry: { maxAttempts: 5, backoff: "fixed", delayMs: 5000 } }], edges: [] },
      null,
    );
    await sleep(10);

    const cancelledAt = performance.now();
    await engine.cancel(run.id);
    await run.finished;

    expect(performance.now() - cancelledAt).toBeLessThan(500);
    expect(attempts).toBe(1);
    expect((await records(run.id)).f).toMatchObject({ status: "cancelled", attempt: 1, error: "nope" });
  });

  test("rejects cancelling a run this engine isn't running, and ignores a run that already ended", async () => {
    const { engine } = setup();
    await expect(engine.cancel("no-such-run")).rejects.toThrow(/no-such-run/);

    const run = await engine.execute({ nodes: [node("w", "test.work@1", { ms: 0 })], edges: [] }, null);
    const finished = await run.finished;
    await engine.cancel(run.id);
    expect(finished.status).toBe("completed");
  });

  test("cancelling twice is harmless", async () => {
    const { engine, events } = setup();
    const run = await engine.execute({ nodes: [node("w", "test.work@1", { ms: 1000 })], edges: [] }, null);
    await sleep(5);

    await Promise.all([engine.cancel(run.id), engine.cancel(run.id)]);

    expect((await run.finished).status).toBe("cancelled");
    expect(events.filter((e) => e.type === "run:cancelled")).toHaveLength(1);
  });
});
