import type { AnyNodeType, WorkflowDefinition } from "./types.ts";

export type ValidationIssue =
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
  for (const node of workflow.nodes) {
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

  const edgesByInput = new Map<string, number[]>();
  workflow.edges.forEach(({ to }, edgeIndex) => {
    const key = JSON.stringify([to.node, to.port]);
    edgesByInput.set(key, [...(edgesByInput.get(key) ?? []), edgeIndex]);
  });
  for (const [key, edgeIndexes] of edgesByInput) {
    if (edgeIndexes.length < 2) continue;
    const [nodeId, port] = JSON.parse(key) as [string, string];
    issues.push({
      code: "multiple-input-edges",
      nodeId,
      port,
      edgeIndexes,
      message: `Input port "${port}" on node "${nodeId}" has ${edgeIndexes.length} incoming edges; use a Merge node to combine them`,
    });
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
 * connected components, via Tarjan's algorithm), with node ids in workflow order.
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

  const visit = (id: string) => {
    index.set(id, index.size);
    lowLink.set(id, index.get(id)!);
    stack.push(id);
    onStack.add(id);
    for (const next of successors.get(id)!) {
      if (!index.has(next)) {
        visit(next);
        lowLink.set(id, Math.min(lowLink.get(id)!, lowLink.get(next)!));
      } else if (onStack.has(next)) {
        lowLink.set(id, Math.min(lowLink.get(id)!, index.get(next)!));
      }
    }
    if (lowLink.get(id) !== index.get(id)) return;

    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    const selfLoop = successors.get(id)!.includes(id);
    if (component.length > 1 || selfLoop) {
      cycles.push(component.sort((a, b) => order.get(a)! - order.get(b)!));
    }
  };

  for (const { id } of nodes) if (!index.has(id)) visit(id);
  return cycles;
}
