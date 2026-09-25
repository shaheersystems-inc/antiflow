import { z } from "zod";
import type { JsonValue } from "../../index.ts";

export const operators = [
  "equals",
  "notEquals",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "contains",
  "exists",
  "truthy",
] as const;

type Operator = (typeof operators)[number];

/** Operators that test the selected value alone, without a `value` to compare against. */
const unary: readonly Operator[] = ["exists", "truthy"];

/** A test of one value: `operator`, and for comparisons the `value` to compare against. */
export const condition = z
  .object({
    operator: z.enum(operators),
    value: z.json().optional().describe("What to compare against; not used by exists and truthy"),
  })
  .refine((c) => c.value !== undefined || unary.includes(c.operator), {
    message: "This operator needs a value to compare against",
    path: ["value"],
  });

export type Condition = z.infer<typeof condition>;

/** `field` config: a dot path into the input. Plain selection, not an expression language. */
export const field = z
  .string()
  .optional()
  .describe("Dot path into the input, e.g. `user.age` or `items.0.name`; the whole input if omitted");

/** The value at a dot path like `items.0.name`, or `undefined` if there's nothing there. */
export function select(input: JsonValue | undefined, path: string | undefined): JsonValue | undefined {
  if (!path) return input;
  let current: JsonValue | undefined = input;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, JsonValue>)[key];
  }
  return current;
}

/** Whether `subject` passes the condition. Orderings only compare two numbers or two strings. */
export function holds(subject: JsonValue | undefined, { operator, value }: Condition): boolean {
  switch (operator) {
    case "equals":
      return jsonEqual(subject, value);
    case "notEquals":
      return !jsonEqual(subject, value);
    case "greaterThan":
      return order(subject, value) > 0;
    case "greaterThanOrEqual":
      return order(subject, value) >= 0;
    case "lessThan":
      return order(subject, value) < 0;
    case "lessThanOrEqual":
      return order(subject, value) <= 0;
    case "contains":
      if (typeof subject === "string") return typeof value === "string" && subject.includes(value);
      return Array.isArray(subject) && subject.some((item) => jsonEqual(item, value));
    case "exists":
      return subject !== undefined && subject !== null;
    case "truthy":
      return Boolean(subject);
  }
}

/** Negative, zero or positive as `a` sorts before, with or after `b`; NaN unless both are numbers or both strings. */
function order(a: JsonValue | undefined, b: JsonValue | undefined): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return Number.NaN;
}

function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((k) => Object.hasOwn(b, k) && jsonEqual((a as Record<string, JsonValue>)[k], (b as Record<string, JsonValue>)[k]))
  );
}
