import type { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---- Node types -----------------------------------------------------------

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface NodeContext {
  runId: string;
  nodeId: string;
  attempt: number;
  logger: Logger;
  signal: AbortSignal;
}

/**
 * A node type with no input ports receives the run's trigger input; otherwise it
 * receives one value per input port, keyed by port name.
 */
export type NodeInput<In extends string> = [In] extends [never]
  ? JsonValue
  : { [P in In]: JsonValue };

export interface DisplayMetadata {
  name: string;
  description?: string;
  category?: string;
  icon?: string;
}

export interface NodeTypeDefinition<
  Config = unknown,
  In extends string = string,
  Out extends string = string,
> {
  type: string;
  version: number;
  inputs: readonly In[];
  outputs: readonly Out[];
  config: z.ZodType<Config>;
  display: DisplayMetadata;
  /** Trigger-capable: declares no input ports, so a UI can show where a run begins. Metadata only. */
  trigger?: boolean;
  /**
   * Returns a bare value when the node type declares one output port. With several output
   * ports it returns an object holding only the ports it fired; the others (and any set to
   * `undefined`) are not fired, so nodes wired to them are skipped. Returning an undeclared
   * port fails the node. A single-output node always fires its port.
   */
  handler: (input: NodeInput<In>, config: Config, context: NodeContext) => Promise<JsonValue>;
}

/** A node type with its config and port types erased, as held by the registry. */
export interface AnyNodeType extends Omit<NodeTypeDefinition, "config" | "handler"> {
  config: z.ZodType;
  handler: (input: any, config: any, context: NodeContext) => Promise<JsonValue>;
}

// ---- Workflow definition --------------------------------------------------

/**
 * Delay before the next attempt: `fixed` waits `delayMs` every time, `exponential` doubles it
 * after each failed attempt, and a function receives the number of the attempt that just
 * failed and returns the delay in ms.
 */
export type Backoff = "fixed" | "exponential" | ((attempt: number) => number);

export interface RetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /** Defaults to `fixed`. */
  backoff?: Backoff;
  /** Base delay for `fixed` and `exponential` backoff. Defaults to 1000. */
  delayMs?: number;
}

export interface WorkflowNode {
  id: string;
  /** Node type id, `type@version`. */
  type: string;
  config: unknown;
  /** Fails an attempt that runs longer than this, aborting its signal. No timeout if unset. */
  timeoutMs?: number;
  /** Retries failed attempts, timeouts included. A single attempt if unset. */
  retry?: RetryPolicy;
}

export interface Edge {
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: Edge[];
}

// ---- Persisted records ----------------------------------------------------

export type RunStatus = "running" | "cancelling" | "cancelled" | "completed" | "failed";
/** `cancelled`: the run was cancelled before the node could finish (or start) running. */
export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export interface RunRecord {
  id: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  workflowSnapshot: WorkflowDefinition;
  input: JsonValue;
}

export interface NodeRecord {
  runId: string;
  nodeId: string;
  status: NodeStatus;
  attempt: number;
  /** A single-output node's result. */
  output?: JsonValue;
  /** A multi-port node's result: only the ports it fired. */
  outputsByPort?: Record<string, JsonValue>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Host-supplied persistence. Writes are whole-record upserts; no transactions are
 * required.
 */
export interface StorageAdapter {
  saveRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  saveNodeRecord(record: NodeRecord): Promise<void>;
  listNodeRecords(runId: string): Promise<NodeRecord[]>;
}

// ---- Events ---------------------------------------------------------------

export type EngineEvent =
  | { type: "node:start"; runId: string; nodeId: string; attempt: number }
  | { type: "node:succeeded"; runId: string; nodeId: string; attempt: number }
  | { type: "node:failed"; runId: string; nodeId: string; attempt: number; error: string }
  | { type: "node:skipped"; runId: string; nodeId: string }
  | { type: "run:completed"; runId: string }
  | { type: "run:failed"; runId: string }
  | { type: "run:cancelled"; runId: string };

export type EngineEventType = EngineEvent["type"];
