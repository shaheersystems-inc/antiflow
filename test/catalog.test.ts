import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createEngine, createInMemoryStorage, defineNodeType, NodeTypeRegistrationError } from "../src/index.ts";
import { append, edge, upper } from "./fixtures.ts";

/** Fake node type with the given version: outputs `v<version>`, ignoring its input. */
function versioned(version: number) {
  return defineNodeType({
    type: "test.versioned",
    version,
    inputs: [],
    outputs: ["out"],
    config: z.object({}),
    display: { name: `Versioned v${version}` },
    handler: async () => `v${version}`,
  });
}

describe("listNodeTypes", () => {
  test("returns every registered node type with its id, ports, display metadata and config schema", () => {
    const engine = createEngine();
    engine.register(upper);
    engine.register(append);

    expect(engine.listNodeTypes()).toEqual([
      {
        id: "test.upper@1",
        type: "test.upper",
        version: 1,
        inputs: [],
        outputs: ["out"],
        trigger: false,
        display: { name: "Upper", description: "Upper-cases the trigger input" },
        configSchema: expect.objectContaining({ type: "object", properties: {} }),
      },
      {
        id: "test.append@1",
        type: "test.append",
        version: 1,
        inputs: ["in"],
        outputs: ["out"],
        trigger: false,
        display: { name: "Append" },
        configSchema: expect.objectContaining({
          type: "object",
          properties: { suffix: { type: "string" } },
          required: ["suffix"],
        }),
      },
    ]);
  });

  test("exposes the config schema as JSON Schema describing the config a UI should collect", () => {
    const engine = createEngine();
    engine.register(
      defineNodeType({
        type: "test.form",
        version: 1,
        inputs: [],
        outputs: ["out"],
        config: z.object({
          url: z.string().describe("Where to send the request"),
          method: z.enum(["GET", "POST"]).default("GET"),
          retries: z.number().int().min(0).optional(),
        }),
        display: { name: "Form", category: "Testing", icon: "globe" },
        handler: async () => null,
      }),
    );

    const [nodeType] = engine.listNodeTypes();
    expect(nodeType?.display).toEqual({ name: "Form", category: "Testing", icon: "globe" });
    // Defaulted and optional fields aren't required from whoever fills in the form.
    expect(nodeType?.configSchema).toMatchObject({
      type: "object",
      properties: {
        url: { type: "string", description: "Where to send the request" },
        method: { type: "string", enum: ["GET", "POST"], default: "GET" },
        retries: { type: "integer", minimum: 0 },
      },
      required: ["url"],
    });
    // The result is plain JSON, safe to send to a UI.
    expect(JSON.parse(JSON.stringify(engine.listNodeTypes()))).toEqual(engine.listNodeTypes());
  });

  test("flags trigger-capable node types", () => {
    const engine = createEngine();
    engine.register(append);
    engine.register(
      defineNodeType({
        type: "test.webhook",
        version: 1,
        trigger: true,
        inputs: [],
        outputs: ["out"],
        config: z.object({}),
        display: { name: "Webhook" },
        handler: async (input) => input,
      }),
    );

    expect(engine.listNodeTypes().map((t) => [t.id, t.trigger])).toEqual([
      ["test.append@1", false],
      ["test.webhook@1", true],
    ]);
  });

  test("returns an empty list when nothing is registered", () => {
    expect(createEngine().listNodeTypes()).toEqual([]);
  });
});

describe("node type versions", () => {
  test("registers several versions of a type at once; each node runs the exact version it names", async () => {
    const storage = createInMemoryStorage();
    const engine = createEngine({ storage });
    engine.register(versioned(1));
    engine.register(versioned(2));

    const run = await engine.execute(
      {
        nodes: [
          { id: "old", type: "test.versioned@1", config: {} },
          { id: "new", type: "test.versioned@2", config: {} },
        ],
        edges: [],
      },
      null,
    );
    await run.finished;

    const outputs = Object.fromEntries((await storage.listNodeRecords(run.id)).map((r) => [r.nodeId, r.output]));
    expect(outputs).toEqual({ old: "v1", new: "v2" });
    expect(engine.listNodeTypes().map((t) => t.id)).toEqual(["test.versioned@1", "test.versioned@2"]);
  });

  test("rejects a node naming a version that isn't registered, even when another version is", async () => {
    const engine = createEngine();
    engine.register(versioned(1));

    await expect(
      engine.execute({ nodes: [{ id: "a", type: "test.versioned@3", config: {} }], edges: [] }, null),
    ).rejects.toMatchObject({ issues: [{ code: "unknown-node-type", nodeId: "a" }] });
  });
});

describe("registration", () => {
  test("rejects registering the same type@version twice, keeping the first registration", async () => {
    const engine = createEngine();
    engine.register(versioned(1));

    expect(() => engine.register({ ...versioned(1), display: { name: "Impostor" } })).toThrow(
      NodeTypeRegistrationError,
    );
    expect(() => engine.register(versioned(1))).toThrow(/test\.versioned@1.*already registered/);
    expect(engine.listNodeTypes().map((t) => t.display.name)).toEqual(["Versioned v1"]);
  });

  const valid = versioned(1);
  const malformed: [string, unknown][] = [
    ["a missing type", { ...valid, type: undefined }],
    ["an empty type", { ...valid, type: "" }],
    ["a type containing @", { ...valid, type: "test@x" }],
    ["a missing version", { ...valid, version: undefined }],
    ["a non-integer version", { ...valid, version: 1.5 }],
    ["a version below 1", { ...valid, version: 0 }],
    ["a missing config schema", { ...valid, config: undefined }],
    ["a config that isn't a Zod schema", { ...valid, config: { suffix: "string" } }],
    ["missing input ports", { ...valid, inputs: undefined }],
    ["missing output ports", { ...valid, outputs: undefined }],
    ["a non-string port name", { ...valid, outputs: [1] }],
    ["an empty port name", { ...valid, inputs: [""] }],
    ["a duplicate port name", { ...valid, outputs: ["out", "out"] }],
    ["missing display metadata", { ...valid, display: undefined }],
    ["display metadata without a name", { ...valid, display: { description: "no name" } }],
    ["a missing handler", { ...valid, handler: undefined }],
    ["a trigger-capable type with input ports", { ...valid, trigger: true, inputs: ["in"] }],
  ];
  test.each(malformed)("rejects a node type definition with %s", (_label, definition) => {
    const engine = createEngine();
    expect(() => engine.register(definition as never)).toThrow(NodeTypeRegistrationError);
    expect(engine.listNodeTypes()).toEqual([]);
  });

  test("lists every problem with a malformed definition", () => {
    const engine = createEngine();
    let error: unknown;
    try {
      engine.register({ ...valid, version: 0, handler: undefined } as never);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NodeTypeRegistrationError);
    expect((error as NodeTypeRegistrationError).problems).toEqual([
      expect.stringMatching(/version/),
      expect.stringMatching(/handler/),
    ]);
  });

  test("still runs workflows with a trigger-capable node type feeding others", async () => {
    const storage = createInMemoryStorage();
    const engine = createEngine({ storage });
    engine.register({ ...upper, trigger: true });
    engine.register(append);

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
    expect((await run.finished).status).toBe("completed");
  });
});
