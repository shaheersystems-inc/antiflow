import { NodeTypeRegistry } from "./registry.ts";
import type { NodeTypeInfo } from "./registry.ts";
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
} from "./types.ts";
import { validateWorkflow, WorkflowValidationError } from "./validation.ts";

export interface EngineOptions {
  storage?: StorageAdapter;
  /** Sink for node logs. Each entry is tagged with runId, nodeId and attempt. Defaults to discarding. */
  logger?: Logger;
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
  const listeners = new Set<(event: EngineEvent) => void>();

  const emit = (event: EngineEvent) => {
    for (const listener of listeners) listener(event);
  };

  async function runWorkflow(run: RunRecord): Promise<RunRecord> {
    const { nodes, edges } = run.workflowSnapshot;
    const outputs = new Map<string, JsonValue>();
    const pending = new Set(nodes.map((n) => n.id));

    const incoming = (nodeId: string) => edges.filter((e) => e.to.node === nodeId);
    const isReady = (nodeId: string) => incoming(nodeId).every((e) => outputs.has(e.from.node));

    while (pending.size > 0) {
      const node = nodes.find((n) => pending.has(n.id) && isReady(n.id))!;
      pending.delete(node.id);
      const nodeType = registry.get(node.type)!;
      const input =
        nodeType.inputs.length === 0
          ? run.input
          : Object.fromEntries(incoming(node.id).map((e) => [e.to.port, outputs.get(e.from.node)!]));
      const record: NodeRecord = {
        runId: run.id,
        nodeId: node.id,
        status: "running",
        attempt: 1,
        startedAt: now(),
      };
      await storage.saveNodeRecord(record);
      emit({ type: "node:start", runId: run.id, nodeId: node.id, attempt: 1 });
      const output = await nodeType.handler(input, nodeType.config.parse(node.config), {
        runId: run.id,
        nodeId: node.id,
        attempt: 1,
        logger: tagLogger(logger, { runId: run.id, nodeId: node.id, attempt: 1 }),
        signal: new AbortController().signal,
      });
      outputs.set(node.id, output);
      await storage.saveNodeRecord({ ...record, status: "succeeded", output, completedAt: now() });
      emit({ type: "node:succeeded", runId: run.id, nodeId: node.id, attempt: 1 });
    }
    const finished: RunRecord = { ...run, status: "completed", completedAt: now() };
    await storage.saveRun(finished);
    emit({ type: "run:completed", runId: run.id });
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

function now(): string {
  return new Date().toISOString();
}
