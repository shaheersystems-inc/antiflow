import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createEngine, createInMemoryStorage, credentialRef, defineNodeType } from "../src/index.ts";
import type { CredentialStore, EngineEvent, JsonValue, StorageAdapter } from "../src/index.ts";
import { edge, node } from "./fixtures.ts";

const SECRET = "s3cr3t-token-9f8e7d";
const NESTED_SECRET = { user: "robot", password: "hunter2-but-longer" };

/** Fake credential store over a fixed map, recording every lookup. */
function fakeStore(secrets: Record<string, JsonValue> = { api: SECRET, db: NESTED_SECRET }) {
  const lookups: string[] = [];
  const store: CredentialStore = {
    async resolve(credentialId) {
      lookups.push(credentialId);
      if (!(credentialId in secrets)) throw new Error(`no such credential; known: ${JSON.stringify(secrets)}`);
      return secrets[credentialId]!;
    },
  };
  return { store, lookups };
}

/**
 * Fake node type that uses its credential: records what it received, logs it, and per
 * `config.mode` returns it, throws it, or returns something harmless.
 */
function caller() {
  const seen: JsonValue[] = [];
  const nodeType = defineNodeType({
    type: "test.call",
    version: 1,
    inputs: [],
    outputs: ["out"],
    config: z.object({
      auth: credentialRef,
      extra: z.object({ db: credentialRef }).optional(),
      mode: z.enum(["ok", "leak-output", "leak-error"]).default("ok"),
    }),
    display: { name: "Call" },
    handler: async (_input, config, context): Promise<JsonValue> => {
      const secret = context.credentials[config.auth.credentialId]!;
      seen.push(secret);
      if (config.extra) seen.push(context.credentials[config.extra.db.credentialId]!);
      context.logger.info(`calling with ${secret}`, { token: secret, nested: { again: `Bearer ${secret}` } });
      if (config.mode === "leak-output") return { echoed: secret, header: `Bearer ${secret}` };
      if (config.mode === "leak-error") throw new Error(`request with ${secret} was rejected`);
      return { status: 200 };
    },
  });
  return { nodeType, seen };
}

function setup(options: { store?: CredentialStore; storage?: StorageAdapter } = {}) {
  const storage = options.storage ?? createInMemoryStorage();
  const logs: unknown[] = [];
  const sink = (message: string, fields?: Record<string, unknown>) => void logs.push({ message, fields });
  const engine = createEngine({
    storage,
    credentials: options.store,
    logger: { debug: sink, info: sink, warn: sink, error: sink },
  });
  const call = caller();
  engine.register(call.nodeType);
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  /** Everything persisted, emitted or logged for a run, as one string. */
  const everything = async (runId: string) =>
    JSON.stringify([await storage.getRun(runId), await storage.listNodeRecords(runId), events, logs]);
  return { engine, storage, events, logs, seen: call.seen, everything };
}

const callNode = (config: Record<string, unknown> = {}) => node("call", "test.call@1", { auth: { credentialId: "api" }, ...config });

describe("credentials", () => {
  test("resolves a credential reference in config and hands the secret to the handler via context", async () => {
    const { store, lookups } = fakeStore();
    const { engine, seen } = setup({ store });

    const run = await engine.execute(
      { nodes: [callNode({ extra: { db: { credentialId: "db" } } })], edges: [] },
      null,
    );

    expect((await run.finished).status).toBe("completed");
    expect(seen).toEqual([SECRET, NESTED_SECRET]);
    expect(lookups.sort()).toEqual(["api", "db"]);
  });

  test("keeps only the reference in the run record, snapshot and node records", async () => {
    const { store } = fakeStore();
    const { engine, storage, everything } = setup({ store });

    const run = await engine.execute({ nodes: [callNode({ extra: { db: { credentialId: "db" } } })], edges: [] }, null);
    await run.finished;

    const snapshotNode = (await storage.getRun(run.id))!.workflowSnapshot.nodes[0]!;
    expect(snapshotNode.config).toEqual({ auth: { credentialId: "api" }, extra: { db: { credentialId: "db" } } });
    const all = await everything(run.id);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(NESTED_SECRET.password);
  });

  test("never lets the secret reach events or log output", async () => {
    const { store } = fakeStore();
    const { engine, logs, events } = setup({ store });

    const run = await engine.execute({ nodes: [callNode()], edges: [] }, null);
    await run.finished;

    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(logs).toEqual([
      {
        message: "calling with [redacted]",
        fields: { runId: run.id, nodeId: "call", attempt: 1, token: "[redacted]", nested: { again: "Bearer [redacted]" } },
      },
    ]);
  });

  test("redacts a secret a handler returns or throws before it's persisted or emitted", async () => {
    const { store } = fakeStore();
    const { engine, storage, everything } = setup({ store });

    const leakedOutput = await engine.execute({ nodes: [callNode({ mode: "leak-output" })], edges: [] }, null);
    await leakedOutput.finished;
    const leakedError = await engine.execute({ nodes: [callNode({ mode: "leak-error" })], edges: [] }, null);
    await leakedError.finished;

    const [output] = await storage.listNodeRecords(leakedOutput.id);
    expect(output?.output).toEqual({ echoed: "[redacted]", header: "Bearer [redacted]" });
    const [failed] = await storage.listNodeRecords(leakedError.id);
    expect(failed).toMatchObject({ status: "failed", error: "request with [redacted] was rejected" });
    expect(await everything(leakedOutput.id)).not.toContain(SECRET);
    expect(await everything(leakedError.id)).not.toContain(SECRET);
  });

  test("downstream nodes receive the redacted value, never the secret", async () => {
    const { store } = fakeStore();
    const { engine, storage } = setup({ store });
    const received: JsonValue[] = [];
    engine.register(
      defineNodeType({
        type: "test.sink",
        version: 1,
        inputs: ["in"],
        outputs: ["out"],
        config: z.object({}),
        display: { name: "Sink" },
        handler: async (input) => {
          received.push(input.in);
          return null;
        },
      }),
    );

    const run = await engine.execute(
      { nodes: [callNode({ mode: "leak-output" }), node("sink", "test.sink@1")], edges: [edge("call", "sink")] },
      null,
    );
    await run.finished;

    expect(JSON.stringify(received)).not.toContain(SECRET);
    expect((await storage.getRun(run.id))?.status).toBe("completed");
  });

  test("still redacts after a resume, resolving the credential again", async () => {
    const storage = createInMemoryStorage();
    const { store, lookups } = fakeStore();
    const first = setup({ store, storage });
    const run = await first.engine.execute({ nodes: [callNode({ mode: "leak-error" })], edges: [] }, null);
    await run.finished;

    // A new engine, as after a restart, over the same storage.
    const second = setup({ store, storage });
    const resumed = await second.engine.resume(run.id);
    await resumed.finished;

    expect(lookups).toEqual(["api", "api"]);
    expect(second.seen).toEqual([SECRET]);
    expect(await second.everything(run.id)).not.toContain(SECRET);
    expect(await first.everything(run.id)).not.toContain(SECRET);
  });

  test("fails the node with a clear error when a reference can't be resolved, without leaking", async () => {
    const { store } = fakeStore();
    const { engine, storage, seen, everything } = setup({ store });

    const run = await engine.execute({ nodes: [callNode({ auth: { credentialId: "missing" } })], edges: [] }, null);
    const finished = await run.finished;

    expect(finished.status).toBe("failed");
    expect(seen).toEqual([]);
    const [record] = await storage.listNodeRecords(run.id);
    expect(record).toMatchObject({ status: "failed", error: 'Credential "missing" could not be resolved' });
    // The store's own error message listed every secret; none of it may surface.
    const all = await everything(run.id);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(NESTED_SECRET.password);
  });

  test("fails the node when config references a credential but no store was supplied", async () => {
    const { engine, storage } = setup();

    const run = await engine.execute({ nodes: [callNode()], edges: [] }, null);
    await run.finished;

    const [record] = await storage.listNodeRecords(run.id);
    expect(record).toMatchObject({ status: "failed", error: expect.stringMatching(/no credential store/i) });
  });

  test("gives handlers of nodes without credential references an empty credentials object", async () => {
    const engine = createEngine();
    let credentials: unknown;
    engine.register(
      defineNodeType({
        type: "test.plain",
        version: 1,
        inputs: [],
        outputs: ["out"],
        config: z.object({}),
        display: { name: "Plain" },
        handler: async (_input, _config, context) => {
          credentials = context.credentials;
          return null;
        },
      }),
    );

    await (await engine.execute({ nodes: [node("p", "test.plain@1")], edges: [] }, null)).finished;

    expect(credentials).toEqual({});
  });
});
