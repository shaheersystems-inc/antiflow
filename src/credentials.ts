import { z } from "zod";
import { mapLogger } from "./logger.ts";
import type { JsonValue, Logger } from "./types.ts";

/**
 * Host-supplied source of secrets. antiflow ships no implementation; a host backs this with
 * its own vault. Resolved secrets are handed to handlers through their context only.
 */
export interface CredentialStore {
  /** The secret for `credentialId`. Rejecting (for any reason) fails the node that needed it. */
  resolve(credentialId: string, context: { runId: string; nodeId: string }): Promise<JsonValue>;
}

/**
 * Zod schema for a credential reference in a node type's config: `{ credentialId }`. The
 * handler reads the resolved secret as `context.credentials[config.<field>.credentialId]`.
 */
export const credentialRef = z
  .object({ credentialId: z.string().min(1) })
  .strict()
  .describe("A reference to a credential in the host's credential store");

export type CredentialRef = z.infer<typeof credentialRef>;

/**
 * Every credential id referenced anywhere in a node's config. Any object of exactly the shape
 * `{ credentialId: string }` is a reference: that shape is reserved for credentials.
 */
export function credentialIds(config: unknown): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    if (credentialRef.safeParse(value).success) ids.add((value as CredentialRef).credentialId);
    for (const child of Object.values(value)) visit(child);
  };
  visit(config);
  return [...ids];
}

/**
 * Resolves every credential referenced in a node's config, keyed by credential id. A failure
 * is reported without the store's own error, which might contain secrets.
 */
export async function resolveCredentials(
  store: CredentialStore | undefined,
  config: unknown,
  context: { runId: string; nodeId: string },
): Promise<{ credentials: Record<string, JsonValue> } | { error: string }> {
  const ids = credentialIds(config);
  if (ids.length === 0) return { credentials: {} };
  if (!store) return { error: "Node config references credentials, but no credential store was supplied to the engine" };
  const credentials: Record<string, JsonValue> = {};
  for (const id of ids) {
    try {
      credentials[id] = await store.resolve(id, context);
    } catch {
      return { error: `Credential "${id}" could not be resolved` };
    }
  }
  return { credentials };
}

const REDACTED = "[redacted]";
/** Secrets shorter than this (as text) aren't redacted: masking them would mangle ordinary text. */
const MIN_REDACTED_LENGTH = 4;

/**
 * Masks the secrets in any value derived from them. Every string or number leaf of a secret
 * (a secret object's leaves included) counts: a string containing it, raw or JSON-escaped,
 * has each occurrence (overlapping ones merged) replaced by `[redacted]`, and a number equal
 * to it becomes `"[redacted]"`. Matching is exact, so a secret the handler transforms
 * (encodes, hashes, splits) isn't caught. Cyclic references become `"[circular]"`, and an
 * `Error` becomes `{ name, message, stack }`, redacted.
 */
export function createRedactor(secrets: JsonValue[]): <T>(value: T) => T {
  const needles = new Set<string>();
  const secretNumbers = new Set<number>();
  const collect = (value: unknown) => {
    if (typeof value === "number") secretNumbers.add(value);
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value);
      if (text.length < MIN_REDACTED_LENGTH) return;
      needles.add(text);
      needles.add(JSON.stringify(text).slice(1, -1));
    } else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect);
  };
  secrets.forEach(collect);
  if (needles.size === 0) return (value) => value;

  const redactString = (text: string) => {
    // Mark every character any needle covers, then replace each covered run once.
    const covered = new Array<boolean>(text.length).fill(false);
    for (const needle of needles) {
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
        covered.fill(true, at, at + needle.length);
      }
    }
    let out = "";
    for (let i = 0; i < text.length; i++) {
      if (!covered[i]) out += text[i];
      else if (i === 0 || !covered[i - 1]) out += REDACTED;
    }
    return out;
  };

  const redact = (value: unknown, seen: WeakSet<object>): unknown => {
    if (typeof value === "string") return redactString(value);
    if (typeof value === "number") return secretNumbers.has(value) ? REDACTED : value;
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    try {
      if (value instanceof Error) {
        return { name: value.name, message: redactString(value.message), stack: value.stack && redactString(value.stack) };
      }
      if (Array.isArray(value)) return value.map((v) => redact(v, seen));
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        let redactedKey = redactString(key);
        // Keys that only differed in a secret mustn't overwrite each other.
        for (let n = 2; redactedKey in out; n++) redactedKey = `${redactString(key)}#${n}`;
        out[redactedKey] = redact(child, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  };
  return (<T>(value: T) => redact(value, new WeakSet()) as T);
}

/** A logger that redacts messages and fields before they reach `sink`. */
export function redactingLogger(sink: Logger, redact: <T>(value: T) => T): Logger {
  return mapLogger(sink, (message, fields) => [redact(message), fields && redact(fields)]);
}
