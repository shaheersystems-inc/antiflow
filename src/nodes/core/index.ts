// The core nodes: built-in control flow, behind their own entry point (`antiflow/nodes/core`).
// They use only the public registration API, like any other node type.
import { z } from "zod";
import { defineNodeType } from "../../index.ts";
import type { Engine, JsonValue } from "../../index.ts";
import { condition, field, holds, select } from "./condition.ts";

const category = "Core";

/** Fires `true` or `false` with its input, depending on whether the input passes a condition. */
export const ifNode = defineNodeType({
  type: "core.if",
  version: 1,
  inputs: ["in"],
  outputs: ["true", "false"],
  config: z.intersection(z.object({ field }), condition),
  display: {
    name: "If",
    description: "Routes its input to the true or false branch by testing a condition",
    category,
    icon: "split",
  },
  handler: async (input, config) => ({ [String(holds(select(input.in, config.field), config))]: input.in }),
});

const SWITCH_CASES = 8;
const casePorts = Array.from({ length: SWITCH_CASES }, (_, i) => `case${i + 1}` as const);

/** Fires the port of the first case its input passes (`case1`, `case2`, …), else `default`. */
export const switchNode = defineNodeType({
  type: "core.switch",
  version: 1,
  inputs: ["in"],
  outputs: [...casePorts, "default"],
  config: z.object({
    field,
    cases: z
      .array(condition)
      .max(SWITCH_CASES)
      .describe(`Tested in order; the first match fires its port (case1 to case${SWITCH_CASES})`),
  }),
  display: {
    name: "Switch",
    description: "Routes its input to the port of the first matching case, or to default",
    category,
    icon: "signpost",
  },
  handler: async (input, config) => {
    const subject = select(input.in, config.field);
    const match = config.cases.findIndex((c) => holds(subject, c));
    return { [match === -1 ? "default" : casePorts[match]!]: input.in };
  },
});

const mergePorts = ["a", "b", "c", "d"] as const;

/**
 * Combines the values arriving on its input ports into one output. Every port is optional,
 * so a Merge after an If or Switch runs with whichever branches were taken; it's skipped only
 * if none of its wired inputs arrive.
 */
export const mergeNode = defineNodeType({
  type: "core.merge",
  version: 1,
  inputs: mergePorts,
  optionalInputs: mergePorts,
  outputs: ["out"],
  config: z.object({
    mode: z
      .enum(["array", "object", "first"])
      .default("array")
      .describe("array: arrived values in port order; object: keyed by port; first: the first arrived value"),
  }),
  display: {
    name: "Merge",
    description: "Combines values from several branches into one",
    category,
    icon: "merge",
  },
  handler: async (input, config) => {
    const arrived = mergePorts.flatMap((port) => (input[port] === undefined ? [] : [[port, input[port]] as const]));
    if (config.mode === "object") return Object.fromEntries(arrived);
    if (config.mode === "first") return arrived[0]?.[1] ?? null;
    return arrived.map(([, value]) => value);
  },
});

/** Outputs a configured value, optionally merged over an object input. */
export const setNode = defineNodeType({
  type: "core.set",
  version: 1,
  inputs: ["in"],
  optionalInputs: ["in"],
  outputs: ["out"],
  config: z.object({
    value: z.json().describe("The value to output"),
    merge: z
      .boolean()
      .default(false)
      .describe("If the input and value are both objects, output the input with value's fields laid over it"),
  }),
  display: {
    name: "Set",
    description: "Outputs a fixed value, or an object input with fields set",
    category,
    icon: "pencil",
  },
  handler: async (input, config) =>
    config.merge && isObject(input.in) && isObject(config.value) ? { ...input.in, ...config.value } : config.value,
});

/** Waits, then passes its input on. Stops early (and fails) if its signal aborts. */
export const delayNode = defineNodeType({
  type: "core.delay",
  version: 1,
  inputs: ["in"],
  outputs: ["out"],
  config: z.object({ ms: z.number().int().min(0).describe("How long to wait, in milliseconds") }),
  display: {
    name: "Delay",
    description: "Waits for a set time before passing its input on",
    category,
    icon: "hourglass",
  },
  handler: async (input, config, { signal }) => {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, config.ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return input.in;
  },
});

/** Registers every core node type with `engine`. */
export function registerCoreNodes(engine: Engine): void {
  engine.register(ifNode);
  engine.register(switchNode);
  engine.register(mergeNode);
  engine.register(setNode);
  engine.register(delayNode);
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
