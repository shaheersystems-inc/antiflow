import type { NodeResult, NodeState } from "./planner.ts";
import type { Scheduler } from "./scheduler.ts";
import { now, sleep } from "./time.ts";
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
 *
 * When `cancel` aborts, the node stops: an attempt waiting for a slot never starts, a running
 * attempt's signal aborts, and a backoff ends early. The node ends `cancelled` unless its
 * running attempt still succeeds.
 */
export async function runNode(
  runner: RunnerContext,
  runId: string,
  node: WorkflowNode,
  nodeType: AnyNodeType,
  input: JsonValue,
  cancel: AbortSignal,
): Promise<NodeState> {
  const { storage, emit } = runner;
  const maxAttempts = node.retry?.maxAttempts ?? 1;
  const startedAt = now();
  // The latest persisted record, which a cancel finalizes.
  let latest: NodeRecord = { runId, nodeId: node.id, status: "pending", attempt: 0 };
  const cancelled = async (): Promise<NodeState> => {
    await storage.saveNodeRecord({ ...latest, status: "cancelled", completedAt: now() });
    return { status: "cancelled" };
  };

  for (let attemptNumber = 1; ; attemptNumber++) {
    const attempt = { runId, nodeId: node.id, attempt: attemptNumber };
    const record: NodeRecord = { ...attempt, status: "running", startedAt };
    const outcome = await runAttempt(runner, node, nodeType, input, record, cancel);
    if (outcome === "not-started") return cancelled();

    if ("result" in outcome) {
      await storage.saveNodeRecord({ ...record, status: "succeeded", ...outcome.result, completedAt: now() });
      emit({ type: "node:succeeded", ...attempt });
      return { status: "succeeded", ...outcome.result };
    }
    let error = outcome.error;
    latest = { ...record, error };
    if (cancel.aborted) return cancelled();
    const delay = attemptNumber < maxAttempts ? backoffDelay(node.retry!, attemptNumber) : undefined;
    if (typeof delay === "string") error = delay;
    if (typeof delay !== "number") {
      await storage.saveNodeRecord({ ...record, status: "failed", error, completedAt: now() });
      emit({ type: "node:failed", ...attempt, error });
      return { status: "failed" };
    }
    // Still running: record the failed attempt's error until the next attempt starts.
    await storage.saveNodeRecord(latest);
    await sleep(delay, cancel);
    if (cancel.aborted) return cancelled();
  }
}

/**
 * Runs one attempt in a scheduler slot and resolves with its outcome, or `not-started` if
 * `cancel` aborted first. The slot is held until the handler really settles, even after a
 * timeout or cancel has already ended the attempt, so a handler that ignores its signal still
 * counts against the concurrency caps.
 */
function runAttempt(
  { storage, scheduler, logger, emit }: RunnerContext,
  node: WorkflowNode,
  nodeType: AnyNodeType,
  input: JsonValue,
  record: NodeRecord,
  cancel: AbortSignal,
): Promise<{ result: NodeResult } | { error: string } | "not-started"> {
  return new Promise((resolve, reject) => {
    scheduler
      .run(
        node.type,
        async () => {
          if (cancel.aborted) return resolve("not-started");
          await storage.saveNodeRecord(record);
          const attempt = { runId: record.runId, nodeId: record.nodeId, attempt: record.attempt };
          emit({ type: "node:start", ...attempt });
          const controller = new AbortController();
          const abortOnCancel = () => controller.abort(new Error("Run cancelled"));
          cancel.addEventListener("abort", abortOnCancel, { once: true });
          const context = { ...attempt, logger: tagLogger(logger, attempt), signal: controller.signal };
          let handling: Promise<JsonValue>;
          try {
            handling = Promise.resolve(nodeType.handler(input, nodeType.config.parse(node.config), context));
          } catch (e) {
            handling = Promise.reject(e);
          }
          try {
            resolve({ result: normalizeResult(nodeType, await withTimeout(handling, node.timeoutMs, controller)) });
          } catch (e) {
            resolve({ error: e instanceof Error ? e.message : String(e) });
          }
          await handling.catch(() => {});
          cancel.removeEventListener("abort", abortOnCancel);
        },
        cancel,
      )
      // The scheduler rejects with the cancel's reason if the attempt never got a slot.
      .catch((error) => (cancel.aborted ? resolve("not-started") : reject(error)));
  });
}

/**
 * Delay in ms before the attempt after `failedAttempt`, or an error message if a custom
 * backoff function returned something that isn't a usable delay.
 */
function backoffDelay({ backoff = "fixed", delayMs = DEFAULT_DELAY_MS }: RetryPolicy, failedAttempt: number): number | string {
  if (backoff === "fixed") return delayMs;
  if (backoff === "exponential") return delayMs * 2 ** (failedAttempt - 1);
  const delay = backoff(failedAttempt);
  return typeof delay === "number" && delay >= 0 && Number.isFinite(delay)
    ? delay
    : `Custom backoff returned ${String(delay)} after attempt ${failedAttempt}; expected a non-negative number of ms`;
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
