import type { AnyNodeType, WorkflowDefinition } from "./types.ts";

export type ValidationIssue =
  | { code: "duplicate-node-id"; nodeId: string; message: string }
  | { code: "unknown-node-type"; nodeId: string; message: string }
  | {
      code: "invalid-config";
      nodeId: string;
      message: string;
      /** The node type's config schema errors, with paths relative to the node's config. */
      configIssues: { path: (string | number)[]; message: string }[];
    }
  | { code: "unknown-edge-node"; edgeIndex: number; nodeId: string; message: string }
  | {
      code: "unknown-port";
      edgeIndex: number;
      nodeId: string;
      port: string;
      direction: "input" | "output";
      message: string;
    }
  | { code: "multiple-input-edges"; nodeId: string; port: string; edgeIndexes: number[]; message: string }
  | { code: "cycle"; nodeIds: string[]; message: string };

/** Thrown by `execute()` when a workflow definition is invalid. Lists every problem found. */
export class WorkflowValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`Invalid workflow definition:\n${issues.map((i) => `- ${i.message}`).join("\n")}`);
    this.name = "WorkflowValidationError";
  }
}

export function validateWorkflow(
  workflow: WorkflowDefinition,
  registry: ReadonlyMap<string, AnyNodeType>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();
  const reportedDuplicates = new Set<string>();
  for (const node of workflow.nodes) {
    if (seenIds.has(node.id) && !reportedDuplicates.has(node.id)) {
      reportedDuplicates.add(node.id);
      issues.push({
        code: "duplicate-node-id",
        nodeId: node.id,
        message: `Node id "${node.id}" is used by more than one node`,
      });
    }
    seenIds.add(node.id);

    const nodeType = registry.get(node.type);
    if (!nodeType) {
      issues.push({
        code: "unknown-node-type",
        nodeId: node.id,
        message: `Node "${node.id}" uses node type "${node.type}", which is not registered`,
      });
      continue;
    }
    const parsed = nodeType.config.safeParse(node.config);
    if (!parsed.success) {
      issues.push({
        code: "invalid-config",
        nodeId: node.id,
        message: `Node "${node.id}" has invalid config`,
        configIssues: parsed.error.issues.map((i) => ({
          path: i.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
          message: i.message,
        })),
      });
    }
  }

  const typeIdByNode = new Map(workflow.nodes.map((n) => [n.id, n.type]));
  workflow.edges.forEach((edge, edgeIndex) => {
    const ends = [
      { ...edge.from, direction: "output" as const },
      { ...edge.to, direction: "input" as const },
    ];
    for (const end of ends) {
      const typeId = typeIdByNode.get(end.node);
      if (typeId === undefined) {
        issues.push({
          code: "unknown-edge-node",
          edgeIndex,
          nodeId: end.node,
          message: `Edge ${edgeIndex} references node "${end.node}", which is not in the workflow`,
        });
        continue;
      }
      // Unregistered node types are already reported above; their ports can't be checked.
      const nodeType = registry.get(typeId);
      const ports = end.direction === "output" ? nodeType?.outputs : nodeType?.inputs;
      if (ports && !ports.includes(end.port)) {
        issues.push({
          code: "unknown-port",
          edgeIndex,
          nodeId: end.node,
          port: end.port,
          direction: end.direction,
          message: `Edge ${edgeIndex} uses ${end.direction} port "${end.port}" on node "${end.node}", which its node type doesn't declare`,
        });
      }
    }
  });

  // Edge indexes grouped by the input port they feed: node id → port → edge indexes.
  const edgesByInput = new Map<string, Map<string, number[]>>();
  workflow.edges.forEach(({ to }, edgeIndex) => {
    let byPort = edgesByInput.get(to.node);
    if (!byPort) edgesByInput.set(to.node, (byPort = new Map()));
    byPort.set(to.port, [...(byPort.get(to.port) ?? []), edgeIndex]);
  });
  for (const [nodeId, byPort] of edgesByInput) {
    for (const [port, edgeIndexes] of byPort) {
      if (edgeIndexes.length < 2) continue;
      issues.push({
        code: "multiple-input-edges",
        nodeId,
        port,
        edgeIndexes,
        message: `Input port "${port}" on node "${nodeId}" has ${edgeIndexes.length} incoming edges; use a Merge node to combine them`,
      });
    }
  }

  for (const nodeIds of findCycles(workflow)) {
    issues.push({
      code: "cycle",
      nodeIds,
      message: `Nodes ${nodeIds.map((id) => `"${id}"`).join(", ")} form a cycle`,
    });
  }
  return issues;
}

/**
 * Returns each group of nodes that lie on a cycle together (the graph's non-trivial strongly
 * connected components, via Tarjan's algorithm), with node ids in workflow order. Iterative,
 * so long chains can't overflow the call stack.
 */
function findCycles({ nodes, edges }: WorkflowDefinition): string[][] {
  const successors = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const { from, to } of edges) {
    if (successors.has(to.node)) successors.get(from.node)?.push(to.node);
  }

  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const enter = (id: string) => {
    index.set(id, index.size);
    lowLink.set(id, index.get(id)!);
    stack.push(id);
    onStack.add(id);
  };

  const closeComponent = (root: string) => {
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== root);
    const selfLoop = successors.get(root)!.includes(root);
    if (component.length > 1 || selfLoop) {
      cycles.push(component.sort((a, b) => order.get(a)! - order.get(b)!));
    }
  };

  for (const { id: start } of nodes) {
    if (index.has(start)) continue;
    enter(start);
    // Each frame is a node being visited and how many of its successors have been explored.
    const frames: { id: string; next: number }[] = [{ id: start, next: 0 }];
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const next = successors.get(frame.id)![frame.next++];
      if (next !== undefined) {
        if (!index.has(next)) {
          enter(next);
          frames.push({ id: next, next: 0 });
        } else if (onStack.has(next)) {
          lowLink.set(frame.id, Math.min(lowLink.get(frame.id)!, index.get(next)!));
        }
        continue;
      }
      // All successors explored: finish this node and propagate its low-link to its parent.
      frames.pop();
      if (lowLink.get(frame.id) === index.get(frame.id)) closeComponent(frame.id);
      const parent = frames.at(-1);
      if (parent) lowLink.set(parent.id, Math.min(lowLink.get(parent.id)!, lowLink.get(frame.id)!));
    }
  }
  return cycles;
}
