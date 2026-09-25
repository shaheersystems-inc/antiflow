import type { Edge, JsonValue, NodeRecord, NodeStatus, WorkflowDefinition, WorkflowNode } from "./types.ts";

/** A succeeded node's result, as its node record holds it. */
export type NodeResult = Pick<NodeRecord, "output" | "outputsByPort">;

/** What the planner needs to know about a node that has been dispatched or decided. */
export interface NodeState extends NodeResult {
  status: NodeStatus;
}

export interface Plan {
  /** Nodes whose inputs have all resolved, with their input values keyed by input port. */
  ready: { node: WorkflowNode; inputs: Record<string, JsonValue> }[];
  /** Nodes with an input that will never resolve, including transitively; in workflow order. */
  skipped: string[];
}

/**
 * Decides what happens next for every node that has no state yet. Pure: no I/O, no timing.
 * An input resolves when its source node succeeded and fired the edge's port. It will never
 * resolve when the source skipped, or succeeded without firing that port. A node is skipped
 * when a required input will never resolve, or when none of its wired inputs ever will; an
 * optional input (per `isOptionalInput`) that never resolves is simply left out.
 */
export function plan(
  { nodes, edges }: WorkflowDefinition,
  states: ReadonlyMap<string, NodeState>,
  isOptionalInput: (node: WorkflowNode, port: string) => boolean = () => false,
): Plan {
  const incoming = new Map<string, Edge[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) incoming.get(e.to.node)?.push(e);

  const decided = new Map(states);
  const resolutions = (node: WorkflowNode) =>
    incoming.get(node.id)!.map((edge) => ({ edge, resolution: portResolution(decided.get(edge.from.node), edge.from.port) }));
  const neverRuns = (node: WorkflowNode) => {
    const all = resolutions(node);
    const never = all.filter(({ resolution }) => resolution.kind === "never");
    return never.some(({ edge }) => !isOptionalInput(node, edge.to.port)) || (all.length > 0 && never.length === all.length);
  };

  const skipped: string[] = [];
  // Repeat until no new skips, so a skip reaches everything downstream of it.
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of nodes) {
      if (decided.has(node.id) || !neverRuns(node)) continue;
      decided.set(node.id, { status: "skipped" });
      skipped.push(node.id);
      changed = true;
    }
  }

  const ready: Plan["ready"] = [];
  for (const node of nodes) {
    if (decided.has(node.id)) continue;
    const all = resolutions(node);
    if (all.some(({ resolution }) => resolution.kind === "not-yet")) continue;
    const inputs: Record<string, JsonValue> = {};
    for (const { edge, resolution } of all) {
      if (resolution.kind === "resolved") inputs[edge.to.port] = resolution.value;
    }
    ready.push({ node, inputs });
  }
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  return { ready, skipped: skipped.sort((a, b) => order.get(a)! - order.get(b)!) };
}

type PortResolution = { kind: "resolved"; value: JsonValue } | { kind: "never" } | { kind: "not-yet" };

/** Whether a node's output port has resolved to a value, never will, or might later. */
function portResolution(source: NodeState | undefined, port: string): PortResolution {
  if (source?.status === "skipped") return { kind: "never" };
  if (source?.status !== "succeeded") return { kind: "not-yet" };
  // A single-output node fires its one port with its output.
  if (!source.outputsByPort) return { kind: "resolved", value: source.output ?? null };
  return Object.hasOwn(source.outputsByPort, port)
    ? { kind: "resolved", value: source.outputsByPort[port]! }
    : { kind: "never" };
}
