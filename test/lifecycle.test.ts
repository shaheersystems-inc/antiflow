import { describe, expect, test } from "bun:test";
import {
  canCancel,
  canResume,
  canTransitionNode,
  canTransitionRun,
  createInMemoryStorage,
  isNodeFinished,
  isRunFinished,
  keepsResultOnResume,
  NODE_STATUSES,
  nodeTransitions,
  RUN_STATUSES,
  runTransitions,
} from "../src/index.ts";
import type { RunRecord } from "../src/index.ts";
import { checkTransitions } from "./fixtures.ts";

const sampleRun = (status: RunRecord["status"]): RunRecord => ({
  id: "r",
  status,
  startedAt: "2026-01-01T00:00:00.000Z",
  workflowSnapshot: { nodes: [], edges: [] },
  input: null,
});

describe("lifecycle", () => {
  test("lists every status once, and transitions only lead to listed statuses", () => {
    expect([...RUN_STATUSES].sort()).toEqual(["cancelled", "cancelling", "completed", "failed", "running"]);
    expect([...NODE_STATUSES].sort()).toEqual(["cancelled", "failed", "pending", "running", "skipped", "succeeded"]);
    for (const to of Object.values(runTransitions).flat()) expect(RUN_STATUSES).toContain(to);
    for (const to of Object.values(nodeTransitions).flat()) expect(NODE_STATUSES).toContain(to);
  });

  test("completed and cancelled runs are final; a failed run only leaves through resume", () => {
    expect(runTransitions.completed).toEqual([]);
    expect(runTransitions.cancelled).toEqual([]);
    expect(runTransitions.failed).toEqual(["running"]);
    expect(canTransitionRun("running", "cancelling")).toBe(true);
    expect(canTransitionRun("cancelling", "running")).toBe(false);
    expect(canTransitionRun("running", "cancelled")).toBe(false);
  });

  test("succeeded, skipped and cancelled nodes are final; a failed node only goes back to pending", () => {
    for (const status of ["succeeded", "skipped", "cancelled"] as const) expect(nodeTransitions[status]).toEqual([]);
    expect(nodeTransitions.failed).toEqual(["pending"]);
    expect(canTransitionNode("pending", "skipped")).toBe(true);
    expect(canTransitionNode("running", "skipped")).toBe(false);
  });

  test("the predicates match what the engine does with each run status", () => {
    const by = (predicate: (s: (typeof RUN_STATUSES)[number]) => boolean) => RUN_STATUSES.filter(predicate).sort();
    expect(by(canResume)).toEqual(["failed", "running"]);
    expect(by(canCancel)).toEqual(["cancelling", "running"]);
    expect(by(isRunFinished)).toEqual(["cancelled", "completed", "failed"]);
  });

  test("the predicates match what the engine does with each node status", () => {
    expect(NODE_STATUSES.filter((s) => !isNodeFinished(s)).sort()).toEqual(["pending", "running"]);
    expect(NODE_STATUSES.filter(keepsResultOnResume).sort()).toEqual(["skipped", "succeeded"]);
  });

  test("the test storage checker rejects writes that break the lifecycle", async () => {
    const storage = checkTransitions(createInMemoryStorage());
    await expect(storage.saveRun(sampleRun("completed"))).rejects.toThrow("Illegal run transition (new) → completed");
    await storage.saveRun(sampleRun("running"));
    await storage.saveRun(sampleRun("completed"));
    await expect(storage.saveRun(sampleRun("running"))).rejects.toThrow("Illegal run transition completed → running");
    await storage.saveNodeRecord({ runId: "r", nodeId: "n", status: "pending", attempt: 0 });
    await expect(storage.saveNodeRecord({ runId: "r", nodeId: "n", status: "succeeded", attempt: 1 })).rejects.toThrow(
      'Illegal node "n" transition pending → succeeded',
    );
  });
});
