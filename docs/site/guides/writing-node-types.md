---
title: Writing node types
description: Handlers, return values, multi-port outputs, the context object and retry-safety.
---

# Writing node types

This guide covers everything a node author needs: the handler contract, how to return values
from one or several ports, what the context provides, and how to write handlers that are safe
to run more than once. For the parts of a node type definition, see
[Node types](../concepts/node-types.md).

## The handler

```ts
handler: async (input, config, context) => output;
```

- `input` is the trigger input for a node type with no input ports. Otherwise it's
  `{ [inputPort]: value }`. See [What a node receives](../concepts/workflows.md#what-a-node-receives).
- `config` is the node's config, **parsed** by the node type's Zod schema, so defaults are
  applied.
- `context` holds the run and node ids, the attempt number, a logger, an abort signal and
  resolved credentials. See [below](#the-context).

Handlers are plain async functions, so you can unit-test them by calling them directly.

Whatever a handler returns must be JSON: `null`, booleans, numbers, strings, arrays and plain
objects. Results are persisted by the storage adapter and passed along edges as data.

## Single-output node types

A node type with one output port returns a **bare value**, which becomes its node record's
`output` and flows along every edge from that port. It always fires its port. Returning
`undefined` is stored as `null`.

```ts
const add = defineNodeType({
  type: "math.add",
  version: 1,
  inputs: ["a", "b"],
  outputs: ["sum"],
  config: z.object({}),
  display: { name: "Add" },
  handler: async (input) => Number(input.a) + Number(input.b),
});
```

## Multi-port node types

A node type with several output ports returns an **object keyed by port name**, containing
only the ports it **fired**. Its node record stores this as `outputsByPort`.

```ts
const validate = defineNodeType({
  type: "app.validateEmail",
  version: 1,
  inputs: ["in"],
  outputs: ["valid", "invalid"],
  config: z.object({ field: z.string().default("email") }),
  display: { name: "Validate email", category: "Data" },
  handler: async (input, config): Promise<JsonValue> => {
    const email = (input.in as Record<string, unknown>)[config.field];
    return typeof email === "string" && email.includes("@")
      ? { valid: input.in } // fires "valid" only
      : { invalid: input.in }; // fires "invalid" only
  },
});
```

- Ports left out of the object, or set to `undefined`, are **not fired**. Nodes wired to them
  are [skipped](../concepts/execution.md#branching-and-skips).
- A handler may fire several ports at once, or none.
- Returning anything but an object (a string, an array, `null`) fails the attempt.
- Returning a port the node type doesn't declare fails the attempt.

## Optional inputs

List input ports in `optionalInputs` when the node can do its job without them. An optional
port may be left unwired, and one whose upstream never fires is left out of `input` instead of
skipping the node. TypeScript types those ports as possibly `undefined`:

```ts
const greet = defineNodeType({
  type: "app.greet",
  version: 1,
  inputs: ["name", "title"],
  optionalInputs: ["title"],
  outputs: ["out"],
  config: z.object({}),
  display: { name: "Greet" },
  handler: async (input) => (input.title ? `Hello, ${input.title} ${input.name}` : `Hello, ${input.name}`),
});
```

A node is still skipped if **none** of its wired inputs resolve.

## Failing

Throw to fail an attempt. Only the error's **message** is stored, in the node record's `error`
and in the `node:failed` event, so make it descriptive:

```ts
if (!response.ok) throw new Error(`POST ${url} failed with ${response.status}`);
```

A failed attempt is retried if the node has a retry policy with attempts left. Otherwise the
node fails, and only its downstream branch halts. See
[Timeouts and retries](timeouts-and-retries.md).

## The context

| Field         | Type                          | Description                                                          |
| ------------- | ----------------------------- | -------------------------------------------------------------------- |
| `runId`       | `string`                      | The run's id.                                                        |
| `nodeId`      | `string`                      | The node's id in the workflow.                                       |
| `attempt`     | `number`                      | 1 for the first attempt, 2 for the first retry, and so on. Restarts at 1 when a run is resumed. |
| `logger`      | `Logger`                      | `debug`, `info`, `warn` and `error`, each `(message, fields?)`. Entries are tagged with `runId`, `nodeId` and `attempt`. |
| `signal`      | `AbortSignal`                 | Aborts on timeout or cancel.                                         |
| `credentials` | `Record<string, JsonValue>`   | Resolved secrets, keyed by credential id. See [Credentials](credentials.md). |

### Honour the signal

A timeout or cancel **doesn't stop your code**. It aborts `context.signal`, and the attempt
ends right away without waiting for your handler. A handler that ignores the signal keeps
running in the background. It still holds its concurrency slot, and its side effects still
happen. So pass the signal to anything abortable, and check it between steps:

```ts
handler: async (input, config, { signal }) => {
  const response = await fetch(config.url, { method: "POST", body: JSON.stringify(input.in), signal });
  signal.throwIfAborted();
  return (await response.json()) as JsonValue;
},
```

### Log through the context logger

```ts
handler: async (input, config, { logger }) => {
  logger.info("sending", { recipients: 3 });
  // ...
},
```

The engine's logger (from `createEngine({ logger })`) receives every entry, with
`{ runId, nodeId, attempt }` added to its fields. Resolved credentials are redacted from
messages and fields. See [Events and logging](events-and-logging.md).

## Write retry-safe handlers

Execution is [at-least-once](../concepts/execution.md#at-least-once-execution). Your handler
can run again for the same node of the same run after a retry, a resume or a crash. Design for
that:

- **Make side effects idempotent.** Derive an idempotency key from the run and node, and pass
  it to the APIs you call:

  ```ts
  handler: async (input, config, { runId, nodeId, signal }) => {
    const response = await fetch("https://api.payments.example/charges", {
      method: "POST",
      headers: { "Idempotency-Key": `${runId}:${nodeId}` },
      body: JSON.stringify({ amount: config.amount }),
      signal,
    });
    return (await response.json()) as JsonValue;
  },
  ```

- **Don't keep state between attempts.** Each attempt starts from scratch with the same input.
- **Honour `context.signal`**, so an abandoned attempt stops doing work.

## Typing tips

- Use `defineNodeType({...})` rather than an object literal, so `input` and `config` are
  inferred.
- `JsonValue` is exported from `antiflow` for typing values that flow between nodes.
- Input port values are typed `JsonValue`. Narrow them, or parse them with Zod, before use.
- Annotate the handler's return type as `Promise<JsonValue>` when it returns different port
  objects from different branches (as `app.validateEmail` above does). Otherwise TypeScript
  infers a union with `undefined` ports, which isn't assignable to `JsonValue`.
- `response.json()` is typed `unknown` or `any` depending on your runtime's types. Cast it to
  `JsonValue` when you return it.
