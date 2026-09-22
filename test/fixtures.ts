import { z } from "zod";
import { defineNodeType } from "../src/index.ts";

/** Fake node type: no inputs, upper-cases the trigger input. */
export const upper = defineNodeType({
  type: "test.upper",
  version: 1,
  inputs: [],
  outputs: ["out"],
  config: z.object({}),
  display: { name: "Upper", description: "Upper-cases the trigger input" },
  handler: async (input) => String(input).toUpperCase(),
});

/** Fake node type: appends `config.suffix` to its `in` port. */
export const append = defineNodeType({
  type: "test.append",
  version: 1,
  inputs: ["in"],
  outputs: ["out"],
  config: z.object({ suffix: z.string() }),
  display: { name: "Append" },
  handler: async (input, config) => `${input.in}${config.suffix}`,
});

/** Edge from `from:out` to `to:in` unless other ports are given. */
export function edge(from: string, to: string, ports: { out?: string; in?: string } = {}) {
  return { from: { node: from, port: ports.out ?? "out" }, to: { node: to, port: ports.in ?? "in" } };
}
