import type { NodeTypeDefinition } from "./types.ts";

/** Identity helper that infers a node type's config and port types for its handler. */
export function defineNodeType<
  Config,
  const In extends string = never,
  const Out extends string = never,
  const Opt extends In = never,
>(definition: NodeTypeDefinition<Config, In, Out, Opt>): NodeTypeDefinition<Config, In, Out, Opt> {
  return definition;
}
