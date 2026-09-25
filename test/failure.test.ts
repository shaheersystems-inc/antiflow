import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineNodeType } from "../src/index.ts";
import { append, edge, harness, join, node, relay, sleep, upper } from "./fixtures.ts";

/** Fake node type that throws `config.message` after `config.ms`. */
const boom = defineNodeType({
  type: "test.boom",
  version: 1,
  inputs: [],
  outputs: ["out"],
  config: z.object({ message: z.string(), ms: z.number().default(0) }),
  display: { name: "Boom" },
  handler: async (_input, config) => {
    await sleep(config.ms);
    throw new Error(config.message);
  },
});

function setup() {
  const { engine, execute } = harness();
  engine.register(boom);
  engine.register(relay);
  engine.register(append);
  engine.register(upper);
  return { engine, execute };
}

describe("node failure", () => {
  test("a throwing handler fails its node, recording the error, and fails the run", async () => {
    const { execute } = setup();

    const { run, records, events } = await execute({
      nodes: [node("b", "test.boom@1", { message: "kaput" })],
      edges: [],
    });

    expect(records.b).toMatchObject({ status: "failed", attempt: 1, error: "kaput" });
    expect(Date.parse(records.b!.completedAt!)).toBeGreaterThanOrEqual(Date.parse(records.b!.startedAt!));
    expect(run.status).toBe("failed");
    expect(run.completedAt).toBeDefined();
    expect(events).toEqual([
      { type: "node:start", runId: run.id, nodeId: "b", attempt: 1 },
      { type: "node:failed", runId: run.id, nodeId: "b", attempt: 1, error: "kaput" },
      { type: "run:failed", runId: run.id },
    ]);
  });

  test("records a readable error when a handler throws something other than an Error", async () => {
    const { engine, execute } = setup();
    engine.register({
      ...upper,
      type: "test.throws-string",
      handler: async () => {
        throw "plain string";
      },
    });
    engine.register({
      ...upper,
      type: "test.throws-sync",
      // A JavaScript host could register a handler that isn't async at all.
      handler: (() => {
        throw new Error("sync");
      }) as never,
    });

    const { records } = await execute({
      nodes: [node("s", "test.throws-string@1"), node("y", "test.throws-sync@1")],
      edges: [],
    });

    expect(records.s).toMatchObject({ status: "failed", error: "plain string" });
    expect(records.y).toMatchObject({ status: "failed", error: "sync" });
  });

  test("nodes downstream of a failed node don't run", async () => {
    const { execute } = setup();

    const { records, events } = await execute({
      nodes: [node("b", "test.boom@1", { message: "kaput" }), node("r1", "test.relay@1", { ms: 0 }), node("r2", "test.relay@1", { ms: 0 })],
      edges: [edge("b", "r1"), edge("r1", "r2")],
    });

    // They stay pending, so the failed node can be retried later.
    expect(records.r1).toMatchObject({ status: "pending", attempt: 0 });
    expect(records.r2).toMatchObject({ status: "pending", attempt: 0 });
    expect(events.map((e) => e.type)).not.toContain("node:skipped");
  });
});

describe("branch isolation", () => {
  test("independent branches run to completion, and the run fails only once they have drained", async () => {
    const { execute } = setup();

    // b fails at once; the u → slow → last branch keeps going.
    const { run, records, events } = await execute({
      nodes: [
        node("b", "test.boom@1", { message: "kaput" }),
        node("after-b", "test.append@1", { suffix: "!" }),
        node("u", "test.upper@1"),
        node("slow", "test.relay@1", { ms: 30 }),
        node("last", "test.append@1", { suffix: "!" }),
      ],
      edges: [edge("b", "after-b"), edge("u", "slow"), edge("slow", "last")],
    });

    expect(records.last).toMatchObject({ status: "succeeded", output: "GO!" });
    expect(records["after-b"]).toMatchObject({ status: "pending" });
    expect(run.status).toBe("failed");
    const order = events.map((e) => ("nodeId" in e ? `${e.type} ${e.nodeId}` : e.type));
    expect(order.indexOf("node:failed b")).toBeLessThan(order.indexOf("node:succeeded slow"));
    expect(order.at(-2)).toBe("node:succeeded last");
    expect(order.at(-1)).toBe("run:failed");
  });

  test("a failure on one side of a join halts the join but not the other side", async () => {
    const { engine, execute } = setup();
    engine.register(join);

    const { run, records } = await execute({
      nodes: [
        node("b", "test.boom@1", { message: "kaput" }),
        node("u", "test.upper@1"),
        node("slow", "test.relay@1", { ms: 20 }),
        node("j", "test.join@1"),
      ],
      edges: [edge("b", "j", { in: "left" }), edge("u", "slow"), edge("slow", "j", { in: "right" })],
    });

    expect(records.slow).toMatchObject({ status: "succeeded" });
    expect(records.j).toMatchObject({ status: "pending" });
    expect(run.status).toBe("failed");
  });
});

describe("failure next to a skip", () => {
  test("a node with one input from a failed node and one from an unfired port is skipped", async () => {
    const { engine, execute } = setup();
    engine.register(join);
    engine.register(
      defineNodeType({
        type: "test.never",
        version: 1,
        inputs: [],
        outputs: ["yes", "no"],
        config: z.object({}),
        display: { name: "Never" },
        handler: async () => ({}),
      }),
    );

    // Even if b were retried and succeeded, j could never run: its right input never fires.
    const { records } = await execute({
      nodes: [node("b", "test.boom@1", { message: "kaput" }), node("n", "test.never@1"), node("j", "test.join@1")],
      edges: [edge("b", "j", { in: "left" }), edge("n", "j", { out: "yes", in: "right" })],
    });

    expect(records.b).toMatchObject({ status: "failed" });
    expect(records.j).toMatchObject({ status: "skipped" });
  });
});
