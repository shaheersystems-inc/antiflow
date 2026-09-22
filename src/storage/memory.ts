import type { NodeRecord, RunRecord, StorageAdapter } from "../types.ts";

/** Reference storage adapter. Stores copies, so callers can't mutate stored state. */
export function createInMemoryStorage(): StorageAdapter {
  const runs = new Map<string, RunRecord>();
  const nodeRecords = new Map<string, Map<string, NodeRecord>>();

  return {
    async saveRun(run) {
      runs.set(run.id, structuredClone(run));
    },
    async getRun(runId) {
      const run = runs.get(runId);
      return run && structuredClone(run);
    },
    async saveNodeRecord(record) {
      let byNode = nodeRecords.get(record.runId);
      if (!byNode) nodeRecords.set(record.runId, (byNode = new Map()));
      byNode.set(record.nodeId, structuredClone(record));
    },
    async listNodeRecords(runId) {
      return [...(nodeRecords.get(runId)?.values() ?? [])].map((r) => structuredClone(r));
    },
  };
}
