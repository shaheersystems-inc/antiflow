import { plan } from "./planner.ts";
import type { NodeState } from "./planner.ts";
import { NodeTypeRegistry } from "./registry.ts";
import type { NodeTypeInfo } from "./registry.ts";
import { runNode } from "./runner.ts";
import type { RunnerContext } from "./runner.ts";
import { createInProcessScheduler } from "./scheduler.ts";
import type { ConcurrencyOptions } from "./scheduler.ts";
import { createInMemoryStorage } from "./storage/memory.ts";
import type {
  AnyNodeType,
  Backoff,
  EngineEvent,
  JsonValue,
  Logger,
  NodeTypeDefinition,
  RunRecord,
  StorageAdapter,
  WorkflowDefinition,
} from "./types.ts";
import { now } from "./time.ts";
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
  const runner: RunnerContext = { storage, scheduler, logger, emit };

  /** Runs `run` to its end against `snapshot`, which may hold values storage can't (backoff functions). */
  async function runWorkflow(run: RunRecord, snapshot: WorkflowDefinition): Promise<RunRecord> {
    const states = new Map<string, NodeState>();
    const inFlight = new Map<string, Promise<void>>();
    // Every node starts out pending; nodes downstream of a failure stay that way.
    await Promise.all(
      snapshot.nodes.map(({ id }) => storage.saveNodeRecord({ runId: run.id, nodeId: id, status: "pending", attempt: 0 })),
    );

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
        const settled = runNode(runner, run.id, node, nodeType, input).then((state) => {
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

      const { snapshot, stored } = takeSnapshot(workflow);
      const run: RunRecord = {
        id: crypto.randomUUID(),
        status: "running",
        startedAt: now(),
        workflowSnapshot: stored,
        input: triggerInput,
      };
      await storage.saveRun(run);
      return { id: run.id, finished: runWorkflow(run, snapshot) };
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;

const noop = () => {};
const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

/**
 * Deep-copies a workflow definition so later edits to it can't affect the run. `snapshot` is
 * what the run executes; `stored` is what gets persisted. Custom backoff functions can't be
 * stored, so only `snapshot` keeps them (by reference), and a run resumed from storage uses
 * the default backoff for those nodes.
 */
function takeSnapshot(workflow: WorkflowDefinition): { snapshot: WorkflowDefinition; stored: WorkflowDefinition } {
  const backoffs = new Map<string, Backoff>();
  const stored: WorkflowDefinition = structuredClone({
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (typeof node.retry?.backoff !== "function") return node;
      const { backoff, ...retry } = node.retry;
      backoffs.set(node.id, backoff);
      return { ...node, retry };
    }),
  });
  const snapshot = structuredClone(stored);
  for (const node of snapshot.nodes) {
    const backoff = backoffs.get(node.id);
    if (backoff) node.retry!.backoff = backoff;
  }
  return { snapshot, stored };
}
