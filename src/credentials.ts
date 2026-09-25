import { z } from "zod";
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

/** Every credential id referenced anywhere in a node's config, as `{ credentialId }` objects. */
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

const REDACTED = "[redacted]";
/** Secret strings shorter than this aren't redacted: masking them would mangle ordinary text. */
const MIN_REDACTED_LENGTH = 4;

/**
 * Replaces every occurrence of the secrets' string values (a secret object's string leaves
 * included) inside strings with `[redacted]`. Redaction is by exact string match, so a
 * secret the handler transforms (encodes, hashes, splits) isn't caught.
 */
export function createRedactor(secrets: JsonValue[]): <T>(value: T) => T {
  const needles = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string" && value.length >= MIN_REDACTED_LENGTH) needles.add(value);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect);
  };
  secrets.forEach(collect);
  // Longest first, so a secret containing another is replaced whole.
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return (value) => value;

  const redactString = (text: string) => ordered.reduce((out, needle) => out.split(needle).join(REDACTED), text);
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactString(k), redact(v)]));
    }
    return value;
  };
  return redact as <T>(value: T) => T;
}

/** A logger that redacts messages and fields before they reach `sink`. */
export function redactingLogger(sink: Logger, redact: <T>(value: T) => T): Logger {
  const level =
    (method: keyof Logger) =>
    (message: string, fields?: Record<string, unknown>) =>
      sink[method](redact(message), fields && redact(fields));
  return { debug: level("debug"), info: level("info"), warn: level("warn"), error: level("error") };
}
