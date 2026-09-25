import type { NodeResult, NodeState } from "./planner.ts";
import type { Scheduler } from "./scheduler.ts";
import type {
  AnyNodeType,
  EngineEvent,
  JsonValue,
  Logger,
  NodeRecord,
  RetryPolicy,
  StorageAdapter,
  WorkflowNode,
} from "./types.ts";

/** What the node runner needs from the engine. */
export interface RunnerContext {
  storage: StorageAdapter;
  scheduler: Scheduler;
  logger: Logger;
  emit: (event: EngineEvent) => void;
}

const DEFAULT_DELAY_MS = 1000;

/**
 * Runs one node to its final state, persisting and announcing its progress. Each attempt
 * waits for a scheduler slot, calls the handler from scratch with the same input, and fails
 * if the handler throws, returns an invalid result or exceeds the node's `timeoutMs`. A failed
 * attempt is retried per the node's retry policy after its backoff; the node fails once its
 * attempts run out. Never rejects for a handler's sake: failures end up in the node's state.
 */
export async function runNode(
  { storage, scheduler, logger, emit }: RunnerContext,
  runId: string,
  node: WorkflowNode,
  nodeType: AnyNodeType,
  input: JsonValue,
): Promise<NodeState> {
  const maxAttempts = node.retry?.maxAttempts ?? 1;
  const startedAt = now();
  for (let attemptNumber = 1; ; attemptNumber++) {
    const attempt = { runId, nodeId: node.id, attempt: attemptNumber };
    const record: NodeRecord = { ...attempt, status: "running", startedAt };
    const outcome = await scheduler.run(node.type, async () => {
      await storage.saveNodeRecord(record);
      emit({ type: "node:start", ...attempt });
      const controller = new AbortController();
      try {
        const context = { ...attempt, logger: tagLogger(logger, attempt), signal: controller.signal };
        const returned = await withTimeout(
          nodeType.handler(input, nodeType.config.parse(node.config), context),
          node.timeoutMs,
          controller,
        );
        return { result: normalizeResult(nodeType, returned) };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    });

    if ("result" in outcome) {
      await storage.saveNodeRecord({ ...record, status: "succeeded", ...outcome.result, completedAt: now() });
      emit({ type: "node:succeeded", ...attempt });
      return { status: "succeeded", ...outcome.result };
    }
    if (attemptNumber >= maxAttempts) {
      await storage.saveNodeRecord({ ...record, status: "failed", error: outcome.error, completedAt: now() });
      emit({ type: "node:failed", ...attempt, error: outcome.error });
      return { status: "failed" };
    }
    // Still running: record the failed attempt's error until the next attempt starts.
    await storage.saveNodeRecord({ ...record, error: outcome.error });
    await sleep(backoffDelay(node.retry!, attemptNumber));
  }
}

/** Delay in ms before the attempt after `failedAttempt`. */
function backoffDelay({ backoff = "fixed", delayMs = DEFAULT_DELAY_MS }: RetryPolicy, failedAttempt: number): number {
  const delay =
    backoff === "fixed" ? delayMs : backoff === "exponential" ? delayMs * 2 ** (failedAttempt - 1) : backoff(failedAttempt);
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}

/**
 * Settles like `promise`, unless `timeoutMs` passes first: then aborts `controller` and
 * rejects with a timeout error without waiting for the handler, which may ignore its signal.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, controller: AbortController): Promise<T> {
  if (timeoutMs === undefined) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`Attempt timed out after ${timeoutMs}ms`);
      error.name = "TimeoutError";
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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

function tagLogger(sink: Logger, tags: Record<string, unknown>): Logger {
  const level =
    (method: keyof Logger) =>
    (message: string, fields?: Record<string, unknown>) =>
      sink[method](message, { ...tags, ...fields });
  return { debug: level("debug"), info: level("info"), warn: level("warn"), error: level("error") };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function now(): string {
  return new Date().toISOString();
}
