---
title: Glossary
description: The terms antiflow's API and documentation use.
---

# Glossary

**Attempt.** One invocation of a node's handler. Retries create new attempts, and each starts
from scratch with the same input.

**At-least-once.** antiflow's execution guarantee: a node may run more than once, so handlers
must be retry-safe. See [Runs and execution](concepts/execution.md#at-least-once-execution).

**Cancel.** Stop scheduling new nodes, abort in-flight attempts through their signal, and move
the run `cancelling → cancelled` once in-flight work drains. See
[Cancellation](guides/cancellation.md).

**Config.** A node's static settings, validated against its node type's Zod schema. It
contains no expressions, since dynamic values arrive through ports.

**Context.** The per-attempt object passed to a handler: `runId`, `nodeId`, `attempt`,
`logger`, `signal` and `credentials`.

**Core nodes.** The built-in control-flow node types (If, Switch, Merge, Set, Delay) in
`antiflow/nodes/core`, registered explicitly by the host.

**Credential reference.** An object `{ credentialId }` in node config, resolved to a secret by
the credential store before each attempt.

**Credential store.** The host-supplied source of secrets.

**Edge.** A connection from one node's output port to another node's input port, carrying
exactly one JSON value.

**Engine.** The object `createEngine()` returns. It holds the registry, storage adapter,
concurrency caps and event listeners.

**Event.** A live notification emitted during a run, such as `node:start` or `run:completed`.

**Fired port.** An output port present in a handler's return value. Ports it leaves out are not
fired.

**Handler.** A node type's async function `(input, config, context) => output`.

**Host.** The application that embeds antiflow. It registers node types, supplies storage (and
optionally a credential store), and decides when to call `execute()`.

**Node.** One instance of a node type inside a workflow definition, with an id, a node type
id, config and optional timeout and retry policy.

**Node record.** The persisted state of one node of a run.

**Node type.** A registered, versioned kind of node: handler, config schema, ports and display
metadata.

**Node type id.** `type@version`, e.g. `core.if@1`.

**Optional input port.** An input port a node type lists in `optionalInputs`. It may be left
unwired, and if it never resolves it's left out of the input instead of skipping the node.

**Port.** A named input or output of a node. Each input port accepts at most one edge.

**Registry.** The engine's set of registered node types.

**Resume.** Continuing a run from persisted state against its snapshot, including retrying
failed nodes. See [Persistence and resume](guides/persistence-and-resume.md).

**Retry policy.** `{ maxAttempts, backoff, delayMs }` on a node.

**Run.** One execution of a workflow, started by `execute(workflow, triggerInput)`.

**Run record.** The persisted state of a run: status, timestamps, snapshot and trigger input.

**Skip.** A node whose inputs will never resolve is marked `skipped` without running, and this
propagates downstream. A skip isn't a failure.

**Snapshot.** The immutable copy of the workflow definition captured when a run starts.

**Storage adapter.** The host-supplied persistence interface for run records and node records.

**Trigger-capable node type.** A node type marked `trigger: true`: it has no inputs and shows a
UI where a run begins. Metadata only.

**Trigger input.** The value passed to `execute()`. Every node without input ports receives it.

**Workflow definition.** The JSON describing nodes and edges.
