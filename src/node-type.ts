import type { NodeTypeDefinition } from "./types.ts";

/** Identity helper that infers a node type's config and port types for its handler. */
export function defineNodeType<Config, const In extends string = never, const Out extends string = never>(
  definition: NodeTypeDefinition<Config, In, Out>,
): NodeTypeDefinition<Config, In, Out> {
  return definition;
}
