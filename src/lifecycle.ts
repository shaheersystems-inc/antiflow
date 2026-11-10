import type { NodeStatus, RunStatus } from "./types.ts";

/**
 * The run lifecycle: every status a run record can move to from each status. A run starts
 * `running`. Self-transitions are listed where the engine rewrites a status (`running →
 * running` when a run its engine stopped mid-run is resumed). `completed` and `cancelled` are
 * final; `failed` only leaves through `resume()`.
 *
 * ```
 * running ──► completed
 *    │  └───► failed ──resume──► running
 *    └──────► cancelling ──► cancelled
 * ```
 */
export const runTransitions: { readonly [S in RunStatus]: readonly RunStatus[] } = {
  running: ["running", "cancelling", "completed", "failed"],
  cancelling: ["cancelled"],
  failed: ["running"],
  completed: [],
  cancelled: [],
};

/**
 * The node lifecycle: every status a node record can move to from each status. A node starts
 * `pending`. `running → running` is a retry (the failed attempt's `error`, then the next
 * attempt). `→ pending` from `running` or `failed` is `resume()` resetting a node to rerun it.
 * `succeeded`, `skipped` and `cancelled` are final.
 *
 * ```
 * pending ──► running ──► succeeded
 *    │           │  └───► failed ──resume──► pending
 *    │           └──────► cancelled
 *    ├──────────────────► skipped
 *    └──────────────────► cancelled
 * ```
 */
export const nodeTransitions: { readonly [S in NodeStatus]: readonly NodeStatus[] } = {
  pending: ["pending", "running", "skipped", "cancelled"],
  running: ["running", "succeeded", "failed", "cancelled", "pending"],
  failed: ["pending"],
  succeeded: [],
  skipped: [],
  cancelled: [],
};

/** Every run status, in lifecycle order. */
export const RUN_STATUSES = Object.keys(runTransitions) as readonly RunStatus[];
/** Every node status, in lifecycle order. */
export const NODE_STATUSES = Object.keys(nodeTransitions) as readonly NodeStatus[];

/** Whether a run record may go from `from` to `to`. */
export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return runTransitions[from].includes(to);
}

/** Whether a node record may go from `from` to `to`. */
export function canTransitionNode(from: NodeStatus, to: NodeStatus): boolean {
  return nodeTransitions[from].includes(to);
}

/** A status a run ends with: what `RunHandle.finished` resolves with. */
export type RunEndStatus = "completed" | "failed" | "cancelled";

/**
 * Whether no engine is driving a run with this status any more: it `completed`, `failed` or was
 * `cancelled`, and `RunHandle.finished` has resolved. A `failed` run can still be resumed.
 */
export function isRunFinished(status: RunStatus): status is RunEndStatus {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Whether `engine.resume()` accepts a run with this status: `failed`, or `running` because its
 * engine stopped mid-run. (Resume can still refuse a run another engine is driving, or one whose
 * node types aren't registered.)
 */
export function canResume(status: RunStatus): boolean {
  return runTransitions[status].includes("running");
}

/**
 * Whether `engine.cancel()` acts on a run with this status: a `running` run is cancelled, a
 * `cancelling` one (left by a crashed engine) is finalized as `cancelled`. Cancelling a finished
 * run does nothing.
 */
export function canCancel(status: RunStatus): boolean {
  return status === "running" || status === "cancelling";
}

/**
 * Whether a node with this status is done for the current pass of its run: it `succeeded`,
 * `failed`, was `skipped` or `cancelled`. Only `pending` and `running` nodes are unfinished; when
 * `run:cancelled` arrives, a UI can render every unfinished node as cancelled.
 */
export function isNodeFinished(status: NodeStatus): boolean {
  return status !== "pending" && status !== "running";
}

/** Whether `resume()` keeps a node with this status, with its result, instead of rerunning it. */
export function keepsResultOnResume(status: NodeStatus): status is "succeeded" | "skipped" {
  return status === "succeeded" || status === "skipped";
}
