import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createEngine, createInMemoryStorage, defineNodeType } from "../src/index.ts";
import type { EngineEvent, JsonValue, WorkflowDefinition } from "../src/index.ts";
import { append, edge, upper } from "./fixtures.ts";

/** Fake multi-port node type: fires the ports named in its config with its trigger input. */
const fire = defineNodeType({
  type: "test.fire",
  version: 1,
  inputs: [],
  outputs: ["yes", "no", "maybe"],
  config: z.object({ ports: z.array(z.string()) }),
  display: { name: "Fire" },
  handler: async (input, config) =>
    Object.fromEntries(config.ports.map((port) => [port, input])) as Record<string, JsonValue>,
});

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

function setup() {
  const storage = createInMemoryStorage();
  const engine = createEngine({ storage });
  engine.register(fire);
  engine.register(append);
  engine.register(join);
  engine.register(upper);
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  const execute = async (workflow: WorkflowDefinition, input: JsonValue = "go") => {
    const run = await engine.execute(workflow, input);
    const finished = await run.finished;
    const records = Object.fromEntries((await storage.listNodeRecords(run.id)).map((r) => [r.nodeId, r]));
    return { run: finished, records, events: events.filter((e) => e.runId === run.id) };
  };
  return { engine, execute };
}

const node = (id: string, type: string, config: unknown = {}) => ({ id, type, config });

describe("multi-port outputs", () => {
  test("persists the fired ports as outputsByPort and runs their downstream with the fired value", async () => {
    const { execute } = setup();

    const { run, records } = await execute({
      nodes: [node("f", "test.fire@1", { ports: ["yes"] }), node("a", "test.append@1", { suffix: "!" })],
      edges: [edge("f", "a", { out: "yes" })],
    });

    expect(run.status).toBe("completed");
    expect(records.f).toMatchObject({ status: "succeeded", outputsByPort: { yes: "go" } });
    expect(records.f).not.toHaveProperty("output");
    expect(records.a).toMatchObject({ status: "succeeded", output: "go!" });
  });

  test("delivers each fired port's value to the nodes wired to it", async () => {
    const { execute } = setup();

    const { records } = await execute({
      nodes: [
        node("f", "test.fire@1", { ports: ["yes", "maybe"] }),
        node("y", "test.append@1", { suffix: "-yes" }),
        node("m", "test.append@1", { suffix: "-maybe" }),
        node("j", "test.join@1"),
      ],
      edges: [
        edge("f", "y", { out: "yes" }),
        edge("f", "m", { out: "maybe" }),
        edge("y", "j", { in: "left" }),
        edge("m", "j", { in: "right" }),
      ],
    });

    expect(records.j).toMatchObject({ status: "succeeded", output: ["go-yes", "go-maybe"] });
  });
});

describe("skip propagation", () => {
  test("skips nodes wired to an unfired port, and everything downstream of them", async () => {
    const { execute } = setup();

    // f ─yes→ a1 → a2
    //   ─no──→ b1 → b2
    const { run, records, events } = await execute({
      nodes: [
        node("f", "test.fire@1", { ports: ["yes"] }),
        node("a1", "test.append@1", { suffix: "1" }),
        node("a2", "test.append@1", { suffix: "2" }),
        node("b1", "test.append@1", { suffix: "1" }),
        node("b2", "test.append@1", { suffix: "2" }),
      ],
      edges: [edge("f", "a1", { out: "yes" }), edge("a1", "a2"), edge("f", "b1", { out: "no" }), edge("b1", "b2")],
    });

    expect(run.status).toBe("completed");
    expect(records.a2).toMatchObject({ status: "succeeded", output: "go12" });
    expect(records.b1).toMatchObject({ status: "skipped" });
    expect(records.b2).toMatchObject({ status: "skipped" });
    expect(events.filter((e) => e.type === "node:skipped")).toEqual([
      { type: "node:skipped", runId: run.id, nodeId: "b1" },
      { type: "node:skipped", runId: run.id, nodeId: "b2" },
    ]);
    // Skipped nodes never start.
    const started = events.flatMap((e) => (e.type === "node:start" ? [e.nodeId] : []));
    expect(started.sort()).toEqual(["a1", "a2", "f"]);
  });

  test("skips a node when any one of its inputs never resolves", async () => {
    const { execute } = setup();

    const { records } = await execute({
      nodes: [
        node("f", "test.fire@1", { ports: ["yes"] }),
        node("u", "test.upper@1"),
        node("j", "test.join@1"),
        node("after", "test.append@1", { suffix: "!" }),
      ],
      edges: [
        edge("u", "j", { in: "left" }),
        edge("f", "j", { out: "no", in: "right" }),
        edge("j", "after"),
      ],
    });

    expect(records.u).toMatchObject({ status: "succeeded" });
    expect(records.j).toMatchObject({ status: "skipped" });
    expect(records.after).toMatchObject({ status: "skipped" });
  });

  test("a multi-port node firing no ports skips all of its downstream", async () => {
    const { execute } = setup();

    const { run, records } = await execute({
      nodes: [node("f", "test.fire@1", { ports: [] }), node("a", "test.append@1", { suffix: "!" })],
      edges: [edge("f", "a", { out: "yes" })],
    });

    expect(run.status).toBe("completed");
    expect(records.f).toMatchObject({ status: "succeeded", outputsByPort: {} });
    expect(records.a).toMatchObject({ status: "skipped" });
  });

  test("a port returned as undefined is not fired", async () => {
    const { engine, execute } = setup();
    engine.register({ ...fire, type: "test.undef", handler: async () => ({ yes: "y", no: undefined }) as never });

    const { records } = await execute({
      nodes: [
        node("f", "test.undef@1", { ports: [] }),
        node("y", "test.append@1", { suffix: "!" }),
        node("n", "test.append@1", { suffix: "!" }),
      ],
      edges: [edge("f", "y", { out: "yes" }), edge("f", "n", { out: "no" })],
    });

    expect(records.f?.outputsByPort).toEqual({ yes: "y" });
    expect(records.y).toMatchObject({ status: "succeeded", output: "y!" });
    expect(records.n).toMatchObject({ status: "skipped" });
  });
});

describe("invalid handler results", () => {
  test("a handler returning a port its node type doesn't declare fails its node", async () => {
    const { execute } = setup();

    const { run, records, events } = await execute({
      nodes: [node("f", "test.fire@1", { ports: ["yes", "bogus"] }), node("a", "test.append@1", { suffix: "!" })],
      edges: [edge("f", "a", { out: "yes" })],
    });

    expect(records.f).toMatchObject({ status: "failed", error: expect.stringContaining("bogus") });
    expect(records.f).not.toHaveProperty("outputsByPort");
    expect(records.a).toBeUndefined();
    expect(events).toContainEqual({ type: "node:failed", runId: run.id, nodeId: "f", attempt: 1, error: expect.any(String) });
    expect(run.status).toBe("failed");
  });

  test("a multi-port handler returning something other than a port map fails its node", async () => {
    const { engine, execute } = setup();
    engine.register({ ...fire, type: "test.bare", handler: async () => "not a map" });

    const { run, records } = await execute({ nodes: [node("b", "test.bare@1", { ports: [] })], edges: [] });

    expect(records.b).toMatchObject({ status: "failed", error: expect.stringContaining("port") });
    expect(run.status).toBe("failed");
  });
});
