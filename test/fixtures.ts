import { z } from "zod";
import { canTransitionNode, canTransitionRun, createEngine, createInMemoryStorage, defineNodeType } from "../src/index.ts";
import type {
  EngineEvent,
  EngineOptions,
  JsonValue,
  NodeRecord,
  NodeStatus,
  RunRecord,
  RunStatus,
  StorageAdapter,
  WorkflowDefinition,
} from "../src/index.ts";

/** Fake node type: no inputs, upper-cases the trigger input. */
export const upper = defineNodeType({
  type: "test.upper",
  version: 1,
  inputs: [],
  outputs: ["out"],
  config: z.object({}),
  display: { name: "Upper", description: "Upper-cases the trigger input" },
  handler: async (input) => String(input).toUpperCase(),
});

/** Fake node type: appends `config.suffix` to its `in` port. */
export const append = defineNodeType({
  type: "test.append",
  version: 1,
  inputs: ["in"],
  outputs: ["out"],
  config: z.object({ suffix: z.string() }),
  display: { name: "Append" },
  handler: async (input, config) => `${input.in}${config.suffix}`,
});

/** Edge from `from:out` to `to:in` unless other ports are given. */
export function edge(from: string, to: string, ports: { out?: string; in?: string } = {}) {
  return { from: { node: from, port: ports.out ?? "out" }, to: { node: to, port: ports.in ?? "in" } };
}

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fake node type joining two inputs into `[left, right]`. */
export const join = defineNodeType({
  type: "test.join",
  version: 1,
  inputs: ["left", "right"],
  outputs: ["out"],
  config: z.object({}),
  display: { name: "Join" },
  handler: async (input) => [input.left, input.right],
});

/** Fake node type passing its `in` port through after `config.ms`. */
export const relay = defineNodeType({
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

/** A workflow node. */
export const node = (id: string, type: string, config: unknown = {}) => ({ id, type, config });

/**
 * Wraps `storage` so every write must follow the run and node lifecycles (`runTransitions`,
 * `nodeTransitions`): a run record starts `running`, a node record `pending`, and each later
 * write moves along a listed transition. An illegal write rejects, failing the run.
 */
export function checkTransitions(storage: StorageAdapter): StorageAdapter {
  const runs = new Map<string, RunStatus>();
  const nodes = new Map<string, NodeStatus>();
  const check = <S extends string>(kind: string, from: S | undefined, to: S, initial: S, allowed: (f: S, t: S) => boolean) => {
    if (from === undefined ? to !== initial : !allowed(from, to)) {
      throw new Error(`Illegal ${kind} transition ${from ?? "(new)"} → ${to}`);
    }
  };
  return {
    ...storage,
    async saveRun(run) {
      check("run", runs.get(run.id), run.status, "running", canTransitionRun);
      runs.set(run.id, run.status);
      await storage.saveRun(run);
    },
    async saveNodeRecord(record) {
      const key = JSON.stringify([record.runId, record.nodeId]);
      check(`node "${record.nodeId}"`, nodes.get(key), record.status, "pending", canTransitionNode);
      nodes.set(key, record.status);
      await storage.saveNodeRecord(record);
    },
  };
}

/**
 * An engine over in-memory storage (or `options.storage`), checked by `checkTransitions`, that
 * records every event, and an `execute` that waits for
 * the run to finish and returns it with its node records (by node id) and its events.
 */
export function harness(options: EngineOptions = {}) {
  const storage = checkTransitions(options.storage ?? createInMemoryStorage());
  const engine = createEngine({ ...options, storage });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  const execute = async (
    workflow: WorkflowDefinition,
    input: JsonValue = "go",
  ): Promise<{ run: RunRecord; records: Record<string, NodeRecord>; events: EngineEvent[] }> => {
    const run = await engine.execute(workflow, input);
    const finished = await run.finished;
    const records = Object.fromEntries((await storage.listNodeRecords(run.id)).map((r) => [r.nodeId, r]));
    return { run: finished, records, events: events.filter((e) => e.runId === run.id) };
  };
  return { engine, storage, execute };
}
