import { z } from "zod";
import type { AnyNodeType, DisplayMetadata } from "./types.ts";

/** A registered node type as `listNodeTypes()` describes it: plain JSON, ready for a UI. */
export interface NodeTypeInfo {
  /** Node type id, `type@version`. */
  id: string;
  type: string;
  version: number;
  inputs: string[];
  outputs: string[];
  /** Whether the node type is trigger-capable: it needs no inputs and can begin a run. */
  trigger: boolean;
  display: DisplayMetadata;
  /**
   * JSON Schema (draft 2020-12) of the config the node accepts, derived from its Zod
   * schema's input side, so fields with defaults are optional. Parts Zod can't express in
   * JSON Schema are left unconstrained.
   */
  configSchema: Record<string, unknown>;
}

/** Thrown by `register()` for a duplicate `type@version` or a malformed node type definition. */
export class NodeTypeRegistrationError extends Error {
  constructor(
    readonly nodeTypeId: string,
    readonly problems: string[],
  ) {
    super(`Cannot register node type "${nodeTypeId}":\n${problems.map((p) => `- ${p}`).join("\n")}`);
    this.name = "NodeTypeRegistrationError";
  }
}

/** The engine's registry: node types by node type id, in registration order. */
export class NodeTypeRegistry {
  readonly #nodeTypes = new Map<string, { nodeType: AnyNodeType; info: NodeTypeInfo }>();

  register(nodeType: AnyNodeType): void {
    const problems = definitionProblems(nodeType);
    const id = problems.length === 0 ? `${nodeType.type}@${nodeType.version}` : describeId(nodeType);
    if (problems.length === 0 && this.#nodeTypes.has(id)) problems.push(`"${id}" is already registered`);
    // Built now so a schema that can't be described fails registration, not every later listing.
    const info = problems.length === 0 ? describe(id, nodeType, problems) : undefined;
    if (!info || problems.length > 0) throw new NodeTypeRegistrationError(id, problems);
    this.#nodeTypes.set(id, { nodeType, info });
  }

  get(id: string): AnyNodeType | undefined {
    return this.#nodeTypes.get(id)?.nodeType;
  }

  list(): NodeTypeInfo[] {
    return [...this.#nodeTypes.values()].map(({ info }) => structuredClone(info));
  }
}

function describe(id: string, nodeType: AnyNodeType, problems: string[]): NodeTypeInfo | undefined {
  let configSchema: Record<string, unknown>;
  try {
    configSchema = z.toJSONSchema(nodeType.config, { io: "input", unrepresentable: "any" });
  } catch (error) {
    problems.push(`config schema can't be described as JSON Schema: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
  const { name, description, category, icon } = nodeType.display;
  return {
    id,
    type: nodeType.type,
    version: nodeType.version,
    inputs: [...nodeType.inputs],
    outputs: [...nodeType.outputs],
    trigger: nodeType.trigger ?? false,
    display: JSON.parse(JSON.stringify({ name, description, category, icon })),
    configSchema,
  };
}

/** Best-effort node type id for an error message about a malformed definition. */
function describeId(nodeType: AnyNodeType | undefined): string {
  const type = typeof nodeType?.type === "string" && nodeType.type !== "" ? nodeType.type : "<no type>";
  return `${type}@${nodeType?.version ?? "<no version>"}`;
}

/** Everything wrong with a node type definition; checked at runtime since hosts may not use TypeScript. */
function definitionProblems(nodeType: AnyNodeType | undefined): string[] {
  if (typeof nodeType !== "object" || nodeType === null) return ["the definition must be an object"];
  const problems: string[] = [];
  const { type, version, inputs, outputs, config, display, handler, trigger } = nodeType;
  if (typeof type !== "string" || type === "" || type.includes("@")) {
    problems.push("type must be a non-empty string without '@'");
  }
  if (!Number.isInteger(version) || version < 1) problems.push("version must be an integer of at least 1");
  problems.push(...portProblems("inputs", inputs), ...portProblems("outputs", outputs));
  // Duck-typed rather than `instanceof`, so schemas from another copy of zod are accepted.
  if (typeof config?.safeParse !== "function" || typeof config?.parse !== "function") {
    problems.push("config must be a Zod schema");
  }
  if (typeof display !== "object" || display === null || typeof display.name !== "string" || display.name === "") {
    problems.push("display must include a non-empty name");
  } else if ((["description", "category", "icon"] as const).some((k) => !["string", "undefined"].includes(typeof display[k]))) {
    problems.push("display description, category and icon must be strings");
  }
  if (typeof handler !== "function") problems.push("handler must be a function");
  if (trigger !== undefined && typeof trigger !== "boolean") problems.push("trigger must be a boolean");
  if (trigger === true && Array.isArray(inputs) && inputs.length > 0) {
    problems.push("a trigger-capable node type can't declare input ports");
  }
  return problems;
}

function portProblems(kind: "inputs" | "outputs", ports: unknown): string[] {
  if (!Array.isArray(ports)) return [`${kind} must be an array of port names`];
  if (!ports.every((p) => typeof p === "string" && p !== "")) return [`${kind} must contain only non-empty strings`];
  if (new Set(ports).size !== ports.length) return [`${kind} must not repeat a port name`];
  return [];
}
