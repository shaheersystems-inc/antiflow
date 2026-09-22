import { describe, expect, test } from "bun:test";
import { createEngine, createInMemoryStorage, WorkflowValidationError } from "../src/index.ts";
import type { EngineEvent, StorageAdapter, WorkflowDefinition } from "../src/index.ts";
import { append, edge, upper } from "./fixtures.ts";

/** An engine with `upper` registered, plus a record of every run saved and event emitted. */
function setup() {
  const inner = createInMemoryStorage();
  const savedRuns: string[] = [];
  const storage: StorageAdapter = {
    ...inner,
    saveRun: async (run) => {
      savedRuns.push(run.id);
      await inner.saveRun(run);
    },
  };
  const engine = createEngine({ storage });
  engine.register(upper);
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, savedRuns, events };
}

async function rejection(promise: Promise<unknown>): Promise<WorkflowValidationError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WorkflowValidationError);
  return error as WorkflowValidationError;
}

describe("workflow validation", () => {
  test("rejects a node whose node type id is not registered, before anything runs", async () => {
    const { engine, savedRuns, events } = setup();
    const workflow: WorkflowDefinition = {
      nodes: [
        { id: "a", type: "test.upper@1", config: {} },
        { id: "b", type: "test.missing@1", config: {} },
      ],
      edges: [],
    };

    const error = await rejection(engine.execute(workflow, "hi"));

    expect(error.issues).toEqual([
      { code: "unknown-node-type", nodeId: "b", message: expect.any(String) },
    ]);
    expect(savedRuns).toEqual([]);
    expect(events).toEqual([]);
  });

  test("rejects node config that fails the node type's schema, naming the node and the schema problems", async () => {
    const { engine } = setup();
    engine.register(append);
    const workflow: WorkflowDefinition = {
      nodes: [
        { id: "a", type: "test.upper@1", config: {} },
        { id: "b", type: "test.append@1", config: { suffix: 42 } },
      ],
      edges: [edge("a", "b")],
    };

    const error = await rejection(engine.execute(workflow, "hi"));

    expect(error.issues).toEqual([
      {
        code: "invalid-config",
        nodeId: "b",
        message: expect.any(String),
        configIssues: [{ path: ["suffix"], message: expect.any(String) }],
      },
    ]);
  });

  test("rejects an edge that references a node not in the workflow", async () => {
    const { engine } = setup();
    engine.register(append);
    const workflow: WorkflowDefinition = {
      nodes: [{ id: "b", type: "test.append@1", config: { suffix: "!" } }],
      edges: [edge("ghost", "b")],
    };

    const error = await rejection(engine.execute(workflow, "hi"));

    expect(error.issues).toEqual([
      { code: "unknown-edge-node", edgeIndex: 0, nodeId: "ghost", message: expect.any(String) },
    ]);
  });

  test("rejects an edge that uses a port its node type doesn't declare", async () => {
    const { engine } = setup();
    engine.register(append);
    const workflow: WorkflowDefinition = {
      nodes: [
        { id: "a", type: "test.upper@1", config: {} },
        { id: "b", type: "test.append@1", config: { suffix: "!" } },
      ],
      edges: [edge("a", "b", { out: "result", in: "text" })],
    };

    const error = await rejection(engine.execute(workflow, "hi"));

    expect(error.issues).toEqual([
      { code: "unknown-port", edgeIndex: 0, nodeId: "a", port: "result", direction: "output", message: expect.any(String) },
      { code: "unknown-port", edgeIndex: 0, nodeId: "b", port: "text", direction: "input", message: expect.any(String) },
    ]);
  });

  test("rejects an input port with more than one incoming edge", async () => {
    const { engine } = setup();
    engine.register(append);
    const workflow: WorkflowDefinition = {
      nodes: [
        { id: "a1", type: "test.upper@1", config: {} },
        { id: "a2", type: "test.upper@1", config: {} },
        { id: "b", type: "test.append@1", config: { suffix: "!" } },
      ],
      edges: [edge("a1", "b"), edge("a2", "b")],
    };

    const error = await rejection(engine.execute(workflow, "hi"));

    expect(error.issues).toEqual([
      { code: "multiple-input-edges", nodeId: "b", port: "in", edgeIndexes: [0, 1], message: expect.any(String) },
    ]);
  });

  test("rejects a cycle, naming only the nodes on it", async () => {
    const { engine } = setup();
    engine.register(append);
    const workflow: WorkflowDefinition = {
      nodes: [
        { id: "b", type: "test.append@1", config: { suffix: "!" } },
        { id: "c", type: "test.append@1", config: { suffix: "?" } },
        { id: "d", type: "test.append@1", config: { suffix: "." } },
      ],
      // b → c → b is the cycle; d is only downstream of it.
      edges: [edge("b", "c"), edge("c", "b"), edge("c", "d")],
    };

    const error = await rejection(engine.execute(workflow, "hi"));

    expect(error.issues).toEqual([{ code: "cycle", nodeIds: ["b", "c"], message: expect.any(String) }]);
  });

  test("reports every problem in the workflow in a single error", async () => {
    const { engine, savedRuns, events } = setup();
    engine.register(append);
    const workflow: WorkflowDefinition = {
      nodes: [
        { id: "a", type: "test.missing@1", config: {} },
        { id: "b", type: "test.append@1", config: {} },
        { id: "loop", type: "test.append@1", config: { suffix: "!" } },
      ],
      edges: [edge("loop", "loop"), edge("b", "ghost")],
    };

    const error = await rejection(engine.execute(workflow, "hi"));

    expect(error.issues.map((i) => i.code).sort()).toEqual([
      "cycle",
      "invalid-config",
      "unknown-edge-node",
      "unknown-node-type",
    ]);
    expect(error.issues.find((i) => i.code === "cycle")).toMatchObject({ nodeIds: ["loop"] });
    expect(error.message).toContain('"test.missing@1"');
    expect(savedRuns).toEqual([]);
    expect(events).toEqual([]);
  });
});
