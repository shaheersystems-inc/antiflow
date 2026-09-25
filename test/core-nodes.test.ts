import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as api from "../src/index.ts";
import { createEngine, defineNodeType } from "../src/index.ts";
import type { JsonValue, WorkflowDefinition } from "../src/index.ts";
import { registerCoreNodes } from "../src/nodes/core/index.ts";
import { edge, harness, node } from "./fixtures.ts";

/** Fake trigger-capable node type: outputs the trigger input. */
const start = defineNodeType({
  type: "test.start",
  version: 1,
  trigger: true,
  inputs: [],
  outputs: ["out"],
  config: z.object({}),
  display: { name: "Start" },
  handler: async (input) => input,
});

/** Fake node type: tags its `in` port's value with its node id. */
const tag = defineNodeType({
  type: "test.tag",
  version: 1,
  inputs: ["in"],
  outputs: ["out"],
  config: z.object({}),
  display: { name: "Tag" },
  handler: async (input, _config, { nodeId }) => ({ [nodeId]: input.in }),
});

function setup() {
  const h = harness();
  registerCoreNodes(h.engine);
  h.engine.register(start);
  h.engine.register(tag);
  return h;
}

const statusesOf = (records: Record<string, api.NodeRecord>) =>
  Object.fromEntries(Object.entries(records).map(([id, r]) => [id, r.status]));

describe("package boundary", () => {
  test("the core package registers and exports no node implementations", () => {
    expect(createEngine().listNodeTypes()).toEqual([]);
    const nodeTypeExports = Object.values(api).filter(
      (value) => typeof value === "object" && value !== null && "handler" in value,
    );
    expect(nodeTypeExports).toEqual([]);
  });

  test("the core nodes publish full metadata once registered", () => {
    const engine = createEngine();
    registerCoreNodes(engine);

    const nodeTypes = engine.listNodeTypes();
    expect(nodeTypes.map((t) => t.id)).toEqual(["core.if@1", "core.switch@1", "core.merge@1", "core.set@1", "core.delay@1"]);
    for (const nodeType of nodeTypes) {
      expect(nodeType.display).toMatchObject({
        name: expect.any(String),
        description: expect.any(String),
        category: "Core",
        icon: expect.any(String),
      });
      expect(nodeType.configSchema).toMatchObject({ type: "object" });
      expect(nodeType.outputs.length).toBeGreaterThan(0);
    }
    expect(nodeTypes.find((t) => t.id === "core.if@1")).toMatchObject({ inputs: ["in"], outputs: ["true", "false"] });
    expect(nodeTypes.find((t) => t.id === "core.merge@1")?.optionalInputs).toEqual(["a", "b", "c", "d"]);
  });
});

describe("core.if", () => {
  // start → if ─true→ yes → yes2
  //            └false→ no → no2
  const branching = (config: unknown): WorkflowDefinition => ({
    nodes: [
      node("start", "test.start@1"),
      node("if", "core.if@1", config),
      node("yes", "test.tag@1"),
      node("yes2", "test.tag@1"),
      node("no", "test.tag@1"),
      node("no2", "test.tag@1"),
    ],
    edges: [
      edge("start", "if"),
      edge("if", "yes", { out: "true" }),
      edge("yes", "yes2"),
      edge("if", "no", { out: "false" }),
      edge("no", "no2"),
    ],
  });

  test("fires true with its input when the condition holds, skipping the false branch", async () => {
    const { execute } = setup();
    const input = { user: { age: 30 } };

    const { run, records } = await execute(branching({ field: "user.age", operator: "greaterThanOrEqual", value: 18 }), input);

    expect(run.status).toBe("completed");
    expect(records.if?.outputsByPort).toEqual({ true: input });
    expect(records.yes?.output).toEqual({ yes: input });
    expect(statusesOf(records)).toMatchObject({ yes: "succeeded", yes2: "succeeded", no: "skipped", no2: "skipped" });
  });

  test("fires false when the condition doesn't hold, skipping the true branch", async () => {
    const { execute } = setup();

    const { records } = await execute(branching({ field: "user.age", operator: "greaterThanOrEqual", value: 18 }), {
      user: { age: 12 },
    });

    expect(Object.keys(records.if!.outputsByPort!)).toEqual(["false"]);
    expect(statusesOf(records)).toMatchObject({ yes: "skipped", yes2: "skipped", no: "succeeded", no2: "succeeded" });
  });

  const conditions: [string, unknown, JsonValue, boolean][] = [
    ["equals on the whole input", { operator: "equals", value: "go" }, "go", true],
    ["equals compares structurally", { operator: "equals", value: { a: [1, 2] } }, { a: [1, 2] }, true],
    ["notEquals", { field: "status", operator: "notEquals", value: "done" }, { status: "open" }, true],
    ["greaterThan on numbers", { field: "n", operator: "greaterThan", value: 5 }, { n: 5 }, false],
    ["lessThan on strings", { field: "s", operator: "lessThan", value: "b" }, { s: "a" }, true],
    ["lessThanOrEqual with mismatched types", { field: "n", operator: "lessThanOrEqual", value: 5 }, { n: "3" }, false],
    ["contains on a string", { field: "title", operator: "contains", value: "flow" }, { title: "antiflow" }, true],
    ["contains on an array", { field: "tags", operator: "contains", value: { id: 2 } }, { tags: [{ id: 1 }, { id: 2 }] }, true],
    ["exists", { field: "items.0.name", operator: "exists" }, { items: [{ name: "x" }] }, true],
    ["exists on a missing field", { field: "missing.deep", operator: "exists" }, { other: 1 }, false],
    ["truthy", { field: "flag", operator: "truthy" }, { flag: 0 }, false],
  ];
  test.each(conditions)("evaluates %s", async (_label, config, input, expected) => {
    const { execute } = setup();

    const { records } = await execute(branching(config), input);

    expect(Object.keys(records.if!.outputsByPort!)).toEqual([String(expected)]);
  });

  test("rejects a condition that needs a value but has none", async () => {
    const { engine } = setup();

    await expect(engine.execute(branching({ operator: "equals" }), null)).rejects.toMatchObject({
      issues: [{ code: "invalid-config", nodeId: "if" }],
    });
  });
});

describe("core.switch", () => {
  // start → switch ─case1→ one
  //                ├case2→ two → two2
  //                └default→ other
  const routing: WorkflowDefinition = {
    nodes: [
      node("start", "test.start@1"),
      node("switch", "core.switch@1", {
        field: "kind",
        cases: [
          { operator: "equals", value: "a" },
          { operator: "contains", value: "b" },
          { operator: "contains", value: "bb" },
        ],
      }),
      node("one", "test.tag@1"),
      node("two", "test.tag@1"),
      node("two2", "test.tag@1"),
      node("three", "test.tag@1"),
      node("other", "test.tag@1"),
    ],
    edges: [
      edge("start", "switch"),
      edge("switch", "one", { out: "case1" }),
      edge("switch", "two", { out: "case2" }),
      edge("two", "two2"),
      edge("switch", "three", { out: "case3" }),
      edge("switch", "other", { out: "default" }),
    ],
  };

  test("fires exactly the first matching case port and skips the rest", async () => {
    const { execute } = setup();

    const { run, records } = await execute(routing, { kind: "bbb" });

    expect(run.status).toBe("completed");
    expect(records.switch?.outputsByPort).toEqual({ case2: { kind: "bbb" } });
    expect(statusesOf(records)).toMatchObject({
      one: "skipped",
      two: "succeeded",
      two2: "succeeded",
      three: "skipped",
      other: "skipped",
    });
  });

  test("fires default when no case matches", async () => {
    const { execute } = setup();

    const { records } = await execute(routing, { kind: "z" });

    expect(Object.keys(records.switch!.outputsByPort!)).toEqual(["default"]);
    expect(statusesOf(records)).toMatchObject({ one: "skipped", two: "skipped", two2: "skipped", other: "succeeded" });
  });

  test("rejects more cases than it has ports", async () => {
    const { engine } = setup();
    const cases = Array.from({ length: 9 }, (_, i) => ({ operator: "equals", value: i }));

    await expect(
      engine.execute(
        { nodes: [node("start", "test.start@1"), node("s", "core.switch@1", { cases })], edges: [edge("start", "s")] },
        null,
      ),
    ).rejects.toMatchObject({ issues: [{ code: "invalid-config", nodeId: "s" }] });
  });
});

describe("core.merge", () => {
  test("rejoins the branches of an If, running with whichever branch was taken", async () => {
    const { execute } = setup();

    // start → if ─true→ yes ─→ merge.a
    //            └false→ no ──→ merge.b → after
    const { run, records } = await execute(
      {
        nodes: [
          node("start", "test.start@1"),
          node("if", "core.if@1", { operator: "truthy" }),
          node("yes", "test.tag@1"),
          node("no", "test.tag@1"),
          node("merge", "core.merge@1", { mode: "first" }),
          node("after", "test.tag@1"),
        ],
        edges: [
          edge("start", "if"),
          edge("if", "yes", { out: "true" }),
          edge("if", "no", { out: "false" }),
          edge("yes", "merge", { in: "a" }),
          edge("no", "merge", { in: "b" }),
          edge("merge", "after"),
        ],
      },
      false,
    );

    expect(run.status).toBe("completed");
    expect(statusesOf(records)).toMatchObject({ yes: "skipped", no: "succeeded", merge: "succeeded" });
    expect(records.after?.output).toEqual({ after: { no: false } });
  });

  const parallel = (mode: string): WorkflowDefinition => ({
    nodes: [
      node("start", "test.start@1"),
      node("x", "test.tag@1"),
      node("y", "test.tag@1"),
      node("merge", "core.merge@1", { mode }),
    ],
    edges: [edge("start", "x"), edge("start", "y"), edge("y", "merge", { in: "a" }), edge("x", "merge", { in: "c" })],
  });

  test("combines every wired input into an array in port order", async () => {
    const { execute } = setup();
    const { records } = await execute(parallel("array"), 1);
    expect(records.merge?.output).toEqual([{ y: 1 }, { x: 1 }]);
  });

  test("combines every wired input into an object keyed by port", async () => {
    const { execute } = setup();
    const { records } = await execute(parallel("object"), 1);
    expect(records.merge?.output).toEqual({ a: { y: 1 }, c: { x: 1 } });
  });

  test("is skipped when none of its inputs arrive", async () => {
    const { execute } = setup();

    const { records } = await execute(
      {
        nodes: [
          node("start", "test.start@1"),
          node("if", "core.if@1", { operator: "truthy" }),
          node("merge", "core.merge@1", {}),
          node("after", "test.tag@1"),
        ],
        edges: [edge("start", "if"), edge("if", "merge", { out: "true", in: "a" }), edge("merge", "after")],
      },
      false,
    );

    expect(statusesOf(records)).toMatchObject({ merge: "skipped", after: "skipped" });
  });
});

describe("core.set", () => {
  test("outputs its configured value, with or without an input", async () => {
    const { execute } = setup();

    const { records } = await execute(
      {
        nodes: [node("start", "test.start@1"), node("fromInput", "core.set@1", { value: { ok: true } }), node("alone", "core.set@1", { value: [1, "two", null] })],
        edges: [edge("start", "fromInput")],
      },
      { ignored: 1 },
    );

    expect(records.fromInput?.output).toEqual({ ok: true });
    expect(records.alone?.output).toEqual([1, "two", null]);
  });

  test("merges its configured fields over an object input", async () => {
    const { execute } = setup();

    const { records } = await execute(
      {
        nodes: [node("start", "test.start@1"), node("set", "core.set@1", { value: { b: 20, c: 3 }, merge: true })],
        edges: [edge("start", "set")],
      },
      { a: 1, b: 2 },
    );

    expect(records.set?.output).toEqual({ a: 1, b: 20, c: 3 });
  });
});

describe("core.delay", () => {
  test("waits the configured time, then passes its input on", async () => {
    const { execute } = setup();
    const started = performance.now();

    const { records } = await execute(
      { nodes: [node("start", "test.start@1"), node("delay", "core.delay@1", { ms: 40 })], edges: [edge("start", "delay")] },
      "later",
    );

    expect(performance.now() - started).toBeGreaterThanOrEqual(38);
    expect(records.delay?.output).toBe("later");
  });

  test("stops early when the run is cancelled", async () => {
    const { engine, storage } = setup();
    const delayStarted = new Promise<void>((resolve) =>
      engine.subscribe((e) => e.type === "node:start" && e.nodeId === "delay" && resolve()),
    );
    const run = await engine.execute(
      { nodes: [node("start", "test.start@1"), node("delay", "core.delay@1", { ms: 10_000 })], edges: [edge("start", "delay")] },
      null,
    );
    await delayStarted;

    const cancelledAt = performance.now();
    await engine.cancel(run.id);
    const finished = await run.finished;

    expect(performance.now() - cancelledAt).toBeLessThan(500);
    expect(finished.status).toBe("cancelled");
    expect((await storage.listNodeRecords(run.id)).find((r) => r.nodeId === "delay")?.status).toBe("cancelled");
  });
});
