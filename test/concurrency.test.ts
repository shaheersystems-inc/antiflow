import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createEngine, createInMemoryStorage, defineNodeType } from "../src/index.ts";
import type { EngineEvent, WorkflowNode } from "../src/index.ts";
import { edge, sleep } from "./fixtures.ts";

/** Records how many handlers are in flight at once, overall and per node type. */
function tracker() {
  const inFlight = new Map<string, number>();
  const max = new Map<string, number>();
  let total = 0;
  let maxTotal = 0;
  return {
    enter(type: string) {
      inFlight.set(type, (inFlight.get(type) ?? 0) + 1);
      max.set(type, Math.max(max.get(type) ?? 0, inFlight.get(type)!));
      maxTotal = Math.max(maxTotal, ++total);
    },
    leave(type: string) {
      inFlight.set(type, inFlight.get(type)! - 1);
      total--;
    },
    max: (type: string) => max.get(type) ?? 0,
    get maxTotal() {
      return maxTotal;
    },
  };
}

/** Fake node type that takes `ms` to run and reports itself to `track`; outputs its node id. */
function slow(type: string, track: ReturnType<typeof tracker>, ms = 20) {
  return defineNodeType({
    type,
    version: 1,
    inputs: [],
    outputs: ["out"],
    config: z.object({}),
    display: { name: type },
    handler: async (_input, _config, context) => {
      track.enter(type);
      await sleep(ms);
      track.leave(type);
      return context.nodeId;
    },
  });
}

/** Fake node type joining two inputs into `[left, right]`. */
const join = defineNodeType({
  type: "test.join",
  version: 1,
  inputs: ["left", "right"],
  outputs: ["out"],
  config: z.object({}),
  display: { name: "Join" },
  handler: async (input) => [input.left, input.right],
});

/** Fake node type passing its `in` port through after `ms`. */
const relay = defineNodeType({
  type: "test.relay",
  version: 1,
  inputs: ["in"],
  outputs: ["out"],
  config: z.object({ ms: z.number() }),
  display: { name: "Relay" },
  handler: async (input, config) => {
    await sleep(config.ms);
    return input.in;
  },
});

const independentNodes = (type: string, count: number): WorkflowNode[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${type}-${i}`, type: `${type}@1`, config: {} }));

describe("concurrent execution", () => {
  test("runs independent nodes in parallel", async () => {
    const track = tracker();
    const engine = createEngine();
    engine.register(slow("test.slow", track));

    const run = await engine.execute({ nodes: independentNodes("test.slow", 3), edges: [] }, null);

    expect((await run.finished).status).toBe("completed");
    expect(track.maxTotal).toBe(3);
  });

  test("runs parallel branches and starts a node only once all its inputs have resolved", async () => {
    const storage = createInMemoryStorage();
    const engine = createEngine({ storage });
    const track = tracker();
    engine.register(slow("test.slow", track));
    engine.register(relay);
    engine.register(join);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    // a ─┬─ fast ─┐
    //    └─ slow ─┴─ joined
    const run = await engine.execute(
      {
        nodes: [
          { id: "a", type: "test.slow@1", config: {} },
          { id: "fast", type: "test.relay@1", config: { ms: 5 } },
          { id: "slow", type: "test.relay@1", config: { ms: 40 } },
          { id: "joined", type: "test.join@1", config: {} },
        ],
        edges: [edge("a", "fast"), edge("a", "slow"), edge("fast", "joined", { in: "left" }), edge("slow", "joined", { in: "right" })],
      },
      null,
    );
    await run.finished;

    const order = events.map((e) => ("nodeId" in e ? `${e.type} ${e.nodeId}` : e.type));
    // Both branches start before either finishes.
    expect(order.indexOf("node:start slow")).toBeLessThan(order.indexOf("node:succeeded fast"));
    // The join waits for its slower input.
    expect(order.indexOf("node:start joined")).toBeGreaterThan(order.indexOf("node:succeeded slow"));
    const joined = (await storage.listNodeRecords(run.id)).find((r) => r.nodeId === "joined");
    expect(joined?.output).toEqual(["a", "a"]);
  });
});

describe("concurrency caps", () => {
  test("a global cap limits how many handlers run at once", async () => {
    const track = tracker();
    const engine = createEngine({ concurrency: { global: 2 } });
    engine.register(slow("test.slow", track));

    const run = await engine.execute({ nodes: independentNodes("test.slow", 5), edges: [] }, null);

    expect((await run.finished).status).toBe("completed");
    expect(track.maxTotal).toBe(2);
  });

  test("the global cap applies across all runs of the engine", async () => {
    const track = tracker();
    const engine = createEngine({ concurrency: { global: 2 } });
    engine.register(slow("test.slow", track));

    const runs = await Promise.all([
      engine.execute({ nodes: independentNodes("test.slow", 3), edges: [] }, null),
      engine.execute({ nodes: independentNodes("test.slow", 3), edges: [] }, null),
    ]);
    const finished = await Promise.all(runs.map((r) => r.finished));

    expect(finished.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(track.maxTotal).toBe(2);
  });

  test("a per-node-type cap limits only that node type", async () => {
    const track = tracker();
    const engine = createEngine({ concurrency: { perNodeType: { "test.limited@1": 1 } } });
    engine.register(slow("test.limited", track));
    engine.register(slow("test.free", track));

    const run = await engine.execute(
      { nodes: [...independentNodes("test.limited", 3), ...independentNodes("test.free", 3)], edges: [] },
      null,
    );

    expect((await run.finished).status).toBe("completed");
    expect(track.max("test.limited")).toBe(1);
    expect(track.max("test.free")).toBe(3);
  });

  test("a node type blocked by its cap doesn't hold back other node types", async () => {
    const track = tracker();
    const engine = createEngine({ concurrency: { global: 2, perNodeType: { "test.limited@1": 1 } } });
    engine.register(slow("test.limited", track, 30));
    engine.register(slow("test.free", track, 30));

    // Limited nodes are listed first, so they queue up ahead of the free ones.
    const run = await engine.execute(
      { nodes: [...independentNodes("test.limited", 3), ...independentNodes("test.free", 1)], edges: [] },
      null,
    );
    await run.finished;

    expect(track.max("test.limited")).toBe(1);
    expect(track.maxTotal).toBe(2);
  });

  test("a node waiting for a slot is recorded as pending", async () => {
    const storage = createInMemoryStorage();
    const engine = createEngine({ storage, concurrency: { global: 1 } });
    const track = tracker();
    engine.register(slow("test.slow", track, 30));

    const run = await engine.execute({ nodes: independentNodes("test.slow", 2), edges: [] }, null);
    await sleep(10);
    const statuses = (await storage.listNodeRecords(run.id)).map((r) => [r.nodeId, r.status]);
    await run.finished;

    expect(statuses).toEqual([
      ["test.slow-0", "running"],
      ["test.slow-1", "pending"],
    ]);
  });

  test.each([0, -1, 1.5, Number.NaN])("rejects an invalid cap of %p", (cap) => {
    expect(() => createEngine({ concurrency: { global: cap } })).toThrow(RangeError);
    expect(() => createEngine({ concurrency: { perNodeType: { "test.slow@1": cap } } })).toThrow(RangeError);
  });
});
