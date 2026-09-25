import { plan } from "./planner.ts";
import type { NodeResult, NodeState } from "./planner.ts";
import { NodeTypeRegistry } from "./registry.ts";
import type { NodeTypeInfo } from "./registry.ts";
import { createInProcessScheduler } from "./scheduler.ts";
import type { ConcurrencyOptions } from "./scheduler.ts";
import { createInMemoryStorage } from "./storage/memory.ts";
import type {
  AnyNodeType,
  EngineEvent,
  JsonValue,
  Logger,
  NodeRecord,
  NodeTypeDefinition,
  RunRecord,
  StorageAdapter,
  WorkflowDefinition,
  WorkflowNode,
} from "./types.ts";
import { validateWorkflow, WorkflowValidationError } from "./validation.ts";

export interface EngineOptions {
  storage?: StorageAdapter;
  /** Sink for node logs. Each entry is tagged with runId, nodeId and attempt. Defaults to discarding. */
  logger?: Logger;
  /** Caps on how many handlers run at once; configured per engine, never in workflow definitions. */
  concurrency?: ConcurrencyOptions;
}

export interface RunHandle {
  id: string;
  /** Resolves with the final run record once the run reaches a terminal status. */
  finished: Promise<RunRecord>;
}

export function createEngine(options: EngineOptions = {}) {
  const storage = options.storage ?? createInMemoryStorage();
  const logger = options.logger ?? silentLogger;
  const registry = new NodeTypeRegistry();
  const scheduler = createInProcessScheduler(options.concurrency);
  const listeners = new Set<(event: EngineEvent) => void>();

  const emit = (event: EngineEvent) => {
    for (const listener of listeners) listener(event);
  };

  async function runWorkflow(run: RunRecord): Promise<RunRecord> {
    const snapshot = run.workflowSnapshot;
    const states = new Map<string, NodeState>();
    const inFlight = new Map<string, Promise<void>>();
    // Every node starts out pending; nodes downstream of a failure stay that way.
    for (const { id } of snapshot.nodes) {
      await storage.saveNodeRecord({ runId: run.id, nodeId: id, status: "pending", attempt: 0 });
    }

    // Skip or start every node the planner can decide, then wait for an in-flight node to
    // settle, which may let it decide more.
    while (true) {
      const { ready, skipped } = plan(snapshot, states);
      for (const nodeId of skipped) {
        states.set(nodeId, { status: "skipped" });
        await storage.saveNodeRecord({ runId: run.id, nodeId, status: "skipped", attempt: 0, completedAt: now() });
        emit({ type: "node:skipped", runId: run.id, nodeId });
      }
      for (const { node, inputs } of ready) {
        states.set(node.id, { status: "running" });
        const nodeType = registry.get(node.type)!;
        const input = nodeType.inputs.length === 0 ? run.input : inputs;
        const settled = runNode(run, node, nodeType, input).then((state) => {
          states.set(node.id, state);
          inFlight.delete(node.id);
        });
        inFlight.set(node.id, settled);
      }
      if (inFlight.size === 0) break;
      await Promise.race(inFlight.values());
    }

    const failed = [...states.values()].some((s) => s.status === "failed");
    const finished: RunRecord = { ...run, status: failed ? "failed" : "completed", completedAt: now() };
    await storage.saveRun(finished);
    emit({ type: failed ? "run:failed" : "run:completed", runId: run.id });
    return finished;
  }

  /**
   * Runs one node once the scheduler grants it a slot, persisting and announcing its progress.
   * Until then its node record stays `pending`. Resolves with the node's final state; a
   * handler that throws, or returns an invalid result, fails the node rather than the run.
   */
  function runNode(run: RunRecord, node: WorkflowNode, nodeType: AnyNodeType, input: JsonValue): Promise<NodeState> {
    return scheduler.run(node.type, async () => {
      const record: NodeRecord = { runId: run.id, nodeId: node.id, status: "running", attempt: 1, startedAt: now() };
      await storage.saveNodeRecord(record);
      emit({ type: "node:start", runId: run.id, nodeId: node.id, attempt: 1 });
      let result: NodeResult;
      try {
        const returned = await nodeType.handler(input, nodeType.config.parse(node.config), {
          runId: run.id,
          nodeId: node.id,
          attempt: 1,
          logger: tagLogger(logger, { runId: run.id, nodeId: node.id, attempt: 1 }),
          signal: new AbortController().signal,
        });
        result = normalizeResult(nodeType, returned);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        await storage.saveNodeRecord({ ...record, status: "failed", error, completedAt: now() });
        emit({ type: "node:failed", runId: run.id, nodeId: node.id, attempt: 1, error });
        return { status: "failed" };
      }
      await storage.saveNodeRecord({ ...record, status: "succeeded", ...result, completedAt: now() });
      emit({ type: "node:succeeded", runId: run.id, nodeId: node.id, attempt: 1 });
      return { status: "succeeded", ...result };
    });
  }

  return {
    /** Listens to live events from every run. Returns a function that unsubscribes. */
    subscribe(listener: (event: EngineEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Adds a node type to the registry under `type@version`. Several versions of a type may
     * be registered at once. Throws `NodeTypeRegistrationError` if that `type@version` is
     * already registered or the definition is malformed.
     */
    register<Config, In extends string, Out extends string>(
      nodeType: NodeTypeDefinition<Config, In, Out>,
    ): void {
      registry.register(nodeType as AnyNodeType);
    },

    /** Every registered node type, in registration order, as plain JSON for a UI's node palette. */
    listNodeTypes(): NodeTypeInfo[] {
      return registry.list();
    },

    /**
     * Starts a run. Rejects with a `WorkflowValidationError` if the workflow definition is
     * invalid; in that case nothing runs and no run record is saved.
     */
    async execute(workflow: WorkflowDefinition, triggerInput: JsonValue): Promise<RunHandle> {
      const issues = validateWorkflow(workflow, registry);
      if (issues.length > 0) throw new WorkflowValidationError(issues);

      const run: RunRecord = {
        id: crypto.randomUUID(),
        status: "running",
        startedAt: now(),
        workflowSnapshot: structuredClone(workflow),
        input: triggerInput,
      };
      await storage.saveRun(run);
      return { id: run.id, finished: runWorkflow(run) };
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;

const noop = () => {};
const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

function tagLogger(sink: Logger, tags: Record<string, unknown>): Logger {
  const level =
    (method: keyof Logger) =>
    (message: string, fields?: Record<string, unknown>) =>
      sink[method](message, { ...tags, ...fields });
  return { debug: level("debug"), info: level("info"), warn: level("warn"), error: level("error") };
}

/**
 * Turns a handler's return value into the node's result: a single-output node's value is its
 * `output`; a multi-port node must return an object of fired ports, all of them declared. A
 * port whose value is `undefined` is not fired.
 */
function normalizeResult(nodeType: AnyNodeType, returned: JsonValue): NodeResult {
  if (nodeType.outputs.length <= 1) return { output: returned ?? null };
  if (typeof returned !== "object" || returned === null || Array.isArray(returned)) {
    throw new Error(
      `Node type "${nodeType.type}@${nodeType.version}" has several output ports, so its handler must return an object keyed by the ports it fired`,
    );
  }
  const undeclared = Object.keys(returned).filter((port) => !nodeType.outputs.includes(port));
  if (undeclared.length > 0) {
    throw new Error(
      `Handler returned undeclared output port(s) ${undeclared.map((p) => `"${p}"`).join(", ")}; node type "${nodeType.type}@${nodeType.version}" declares ${nodeType.outputs.map((p) => `"${p}"`).join(", ")}`,
    );
  }
  return { outputsByPort: Object.fromEntries(Object.entries(returned).filter(([, value]) => value !== undefined)) };
}

function now(): string {
  return new Date().toISOString();
}
