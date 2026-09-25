import type { Edge, JsonValue, NodeStatus, WorkflowDefinition, WorkflowNode } from "./types.ts";

/** What the planner needs to know about a node that has been dispatched or decided. */
export interface NodeState {
  status: NodeStatus;
  output?: JsonValue;
  outputsByPort?: Record<string, JsonValue>;
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
 * resolve when the source skipped, or succeeded without firing that port.
 */
export function plan({ nodes, edges }: WorkflowDefinition, states: ReadonlyMap<string, NodeState>): Plan {
  const incoming = new Map<string, Edge[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) incoming.get(e.to.node)?.push(e);

  const decided = new Map(states);
  const skipped: string[] = [];
  // Repeat until no new skips, so a skip reaches everything downstream of it.
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of nodes) {
      if (decided.has(node.id)) continue;
      if (incoming.get(node.id)!.some((e) => resolve(decided.get(e.from.node), e.from.port) === "never")) {
        decided.set(node.id, { status: "skipped" });
        skipped.push(node.id);
        changed = true;
      }
    }
  }

  const ready: Plan["ready"] = [];
  for (const node of nodes) {
    if (decided.has(node.id)) continue;
    const inputs: Record<string, JsonValue> = {};
    const allResolved = incoming.get(node.id)!.every((e) => {
      const resolution = resolve(decided.get(e.from.node), e.from.port);
      if (typeof resolution !== "object") return false;
      inputs[e.to.port] = resolution.value;
      return true;
    });
    if (allResolved) ready.push({ node, inputs });
  }
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  return { ready, skipped: skipped.sort((a, b) => order.get(a)! - order.get(b)!) };
}

/** Whether a node's output port has resolved to a value, never will, or might later. */
function resolve(source: NodeState | undefined, port: string): { value: JsonValue } | "never" | "not-yet" {
  if (source?.status === "skipped") return "never";
  if (source?.status !== "succeeded") return "not-yet";
  if (!source.outputsByPort) return { value: source.output ?? null };
  return Object.hasOwn(source.outputsByPort, port) ? { value: source.outputsByPort[port]! } : "never";
}
