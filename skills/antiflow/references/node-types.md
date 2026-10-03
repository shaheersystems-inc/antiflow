# Writing node types

## Contents

- [Definition](#definition)
- [Handler contract](#handler-contract)
- [Single-output and multi-port results](#single-output-and-multi-port-results)
- [Optional inputs](#optional-inputs)
- [The context](#the-context)
- [Retry-safe, cancellable handlers](#retry-safe-cancellable-handlers)
- [Credentials in a handler](#credentials-in-a-handler)
- [Versioning](#versioning)
- [Registration errors](#registration-errors)
- [Typing tips](#typing-tips)
- [Packaging node types](#packaging-node-types)

## Definition

```ts
import { defineNodeType } from "antiflow";
import type { JsonValue } from "antiflow";
import { z } from "zod";

export const httpGet = defineNodeType({
  type: "http.get", // non-empty, no "@", namespaced
  version: 1, // integer >= 1; id is "http.get@1"
  inputs: ["in"], // [] = receives the run's trigger input
  outputs: ["out"], // 1 port = bare value; several = map of fired ports
  config: z.object({
    url: z.url().describe("The URL to fetch"), // .describe() becomes UI help text
    headers: z.record(z.string(), z.string()).default({}),
  }),
  display: { name: "HTTP GET", description: "Fetches a URL", category: "HTTP", icon: "globe" },
  handler: async (_input, config, { signal }) => {
    const response = await fetch(config.url, { headers: config.headers, signal });
    if (!response.ok) throw new Error(`GET ${config.url} failed with ${response.status}`);
    return (await response.json()) as JsonValue;
  },
});
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| `type` | yes | e.g. `app.sendEmail`. Prefix with a namespace. Don't use `core.`, which is taken by the built-ins. |
| `version` | yes | Integer ≥ 1. |
| `inputs` | yes | Unique, non-empty port names. `[]` = trigger input. |
| `optionalInputs` | no | Subset of `inputs` that may stay unwired or unresolved. |
| `outputs` | yes | Unique, non-empty port names. |
| `config` | yes | Zod 4 schema. It must be convertible to JSON Schema (`z.toJSONSchema`). |
| `display` | yes | `{ name, description?, category?, icon? }`, all strings. `name` must be non-empty. |
| `trigger` | no | `true` = UI start node. Only allowed with `inputs: []`. Metadata only. |
| `handler` | yes | `async (input, config, context) => JsonValue`. |

Always wrap the definition in `defineNodeType(...)`. It returns its argument unchanged, but
lets TypeScript infer `input` from the ports and `config` from the schema.

Config schemas do three jobs: validation in `execute()`, **parsing** (the handler receives
parsed config with defaults applied, while the stored workflow keeps the config as written),
and describing the config as JSON Schema in `listNodeTypes()`.

## Handler contract

```ts
handler: async (input, config, context) => output
```

- `input`: the trigger input if `inputs` is `[]`. Otherwise `{ [port]: JsonValue }` with one
  entry per input port that received a value.
- `config`: parsed by the Zod schema.
- `context`: see [The context](#the-context).
- Return JSON only. Returning `undefined` from a single-output handler is stored as `null`.
- Throw to fail the attempt. Only `error.message` is stored (node record `error`,
  `node:failed` event), so write descriptive messages. A failed attempt is retried if the
  node's retry policy allows. Otherwise the node fails and only its downstream branch halts.

## Single-output and multi-port results

**One output port**: return the value. It always fires.

```ts
handler: async (input) => Number(input.a) + Number(input.b),
```

**Several output ports**: return an object containing only the fired ports. This is how
custom branching works.

```ts
const validateEmail = defineNodeType({
  type: "app.validateEmail",
  version: 1,
  inputs: ["in"],
  outputs: ["valid", "invalid"],
  config: z.object({ field: z.string().default("email") }),
  display: { name: "Validate email", category: "Data" },
  handler: async (input, config): Promise<JsonValue> => {
    const email = (input.in as Record<string, unknown>)[config.field];
    return typeof email === "string" && email.includes("@") ? { valid: input.in } : { invalid: input.in };
  },
});
```

- Ports left out, or set to `undefined`, aren't fired. Their downstream nodes are skipped.
- Firing several ports, or none, is allowed.
- Returning a non-object (string, array, `null`), or an undeclared port name, fails the
  attempt.
- The node record stores the result as `outputsByPort` (fired ports only), not `output`.

## Optional inputs

```ts
defineNodeType({
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

An optional port may be unwired. If its upstream never fires, it's left out of `input` and
the node still runs. TypeScript types it as possibly `undefined`. The node is still
skipped if **none** of its wired inputs resolve. Use optional inputs for any node that rejoins
branches.

## The context

| Field | Type | Use |
| ----- | ---- | --- |
| `runId` | `string` | Idempotency keys, correlation. |
| `nodeId` | `string` | Same. |
| `attempt` | `number` | 1-based. Restarts at 1 on resume. |
| `logger` | `Logger` | `debug/info/warn/error(message, fields?)`. Tagged with `runId`, `nodeId`, `attempt`, and redacted of secrets. |
| `signal` | `AbortSignal` | Aborts on timeout (reason `TimeoutError`) or cancel (reason `Run cancelled`). |
| `credentials` | `Readonly<Record<string, JsonValue>>` | Resolved secrets keyed by credential id. |

## Retry-safe, cancellable handlers

antiflow is at-least-once, so a handler can run again for the same node of the same run.

```ts
handler: async (input, config, { runId, nodeId, signal }) => {
  const response = await fetch("https://api.payments.example/charges", {
    method: "POST",
    headers: { "Idempotency-Key": `${runId}:${nodeId}` }, // the same key on every re-run
    body: JSON.stringify({ amount: config.amount }),
    signal, // a timeout or cancel aborts the request
  });
  signal.throwIfAborted(); // check between steps
  if (!response.ok) throw new Error(`Charge failed with ${response.status}`);
  return (await response.json()) as JsonValue;
},
```

- Keep no state between attempts (module-level caches keyed by run are a smell). Each
  attempt starts from scratch with the same input.
- A handler that ignores `signal` keeps running in the background after its attempt has
  ended, still holds its concurrency slot, and its result is discarded.
- A waiting handler should reject when the signal aborts:

```ts
await new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, config.ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
```

## Credentials in a handler

```ts
import { credentialRef, defineNodeType } from "antiflow";

const slackPost = defineNodeType({
  type: "slack.post",
  version: 1,
  inputs: ["in"],
  outputs: ["out"],
  config: z.object({ auth: credentialRef, channel: z.string() }),
  display: { name: "Post to Slack", category: "Slack" },
  handler: async (input, config, { credentials, signal }) => {
    const token = credentials[config.auth.credentialId] as string;
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: config.channel, text: String(input.in) }),
      signal,
    });
    return (await response.json()) as JsonValue;
  },
});
```

- Workflow config holds only `{ "auth": { "credentialId": "slack-acme" } }`. The host's
  `CredentialStore` resolves it before each attempt (see
  [hosting.md](hosting.md#credential-stores)).
- **Any** config object shaped exactly `{ credentialId: string }` is treated as a reference,
  whatever the schema says. Don't use that shape for anything else.
- Secrets (each string/number leaf of at least 4 characters) are redacted from outputs, error
  messages and log entries. Matching is exact: a base64-encoded, hashed, split or re-cased
  secret is **not** caught. Never return, log or throw secrets.
- If resolution fails, or the engine has no credential store, the attempt fails with
  `Credential "<id>" could not be resolved`.

## Versioning

- Bump `version` for a new config shape, renamed or removed ports, or changed behaviour.
  Register both versions side by side:
  `engine.register(httpGetV1); engine.register(httpGetV2);`.
- Keep the old version registered while stored workflows or unfinished runs reference it.
  `resume()` refuses a run whose snapshot uses an unregistered id. It never silently swaps
  versions.
- The engine can't detect a changed handler under the **same** version. That's the author's
  responsibility.

## Registration errors

`engine.register()` validates at runtime and throws `NodeTypeRegistrationError` with
`nodeTypeId` and `problems` (every problem) if:

- the `type@version` is already registered
- `type` is empty or contains `@`, or `version` isn't an integer ≥ 1
- port lists aren't arrays of unique non-empty strings, or `optionalInputs` names a port
  not in `inputs`
- `config` isn't a Zod schema, or can't be converted to JSON Schema
- `display.name` is missing or empty, or another display field isn't a string
- `handler` isn't a function
- `trigger` isn't a boolean, or `trigger: true` with input ports

## Typing tips

- Input values are `JsonValue`. Narrow them, or parse with Zod, before use:
  `const order = Order.parse(input.in);`.
- Annotate `Promise<JsonValue>` on handlers that return different port objects from
  different branches. Otherwise TypeScript infers a union with `undefined` ports that isn't
  assignable.
- Cast `await response.json()` to `JsonValue`.
- Use `AnyNodeType` for heterogeneous lists:
  `const nodes: AnyNodeType[] = [httpGet, slackPost]; nodes.forEach((n) => engine.register(n));`.

## Packaging node types

Follow the core-nodes pattern: export each node type, plus a `registerXNodes(engine: Engine)`
helper that calls `engine.register` for each, and import only from `antiflow` (the public
API). Integration nodes belong in their own module or package, never inside the engine.
