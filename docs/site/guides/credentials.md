---
title: Credentials
description: Reference secrets from node config, resolve them from your own vault, and keep them out of storage, events and logs.
---

# Credentials

Nodes that call external services need secrets such as API keys, OAuth tokens or database
passwords. antiflow keeps secrets **out of workflow definitions and persisted state**:

- Node config holds only a **reference**, `{ credentialId: "..." }`.
- Your **credential store** resolves the reference just before each attempt.
- The handler receives the secret through `context.credentials`.
- Anything derived from the attempt (outputs, errors, log entries) is **redacted** before it
  leaves the attempt.

## 1. Implement a credential store

A `CredentialStore` has one method. antiflow ships no implementation, so back it with your own
vault, secrets manager or encrypted table:

```ts
import { createEngine } from "antiflow";
import type { CredentialStore } from "antiflow";

const credentials: CredentialStore = {
  async resolve(credentialId, { runId, nodeId }) {
    // Look up the secret, e.g. scoped to the tenant that owns runId.
    const secret = await vault.read(`workflows/${credentialId}`);
    if (!secret) throw new Error("not found");
    return secret; // any JSON value: a string, or an object like { user, password }
  },
};

const engine = createEngine({ credentials });
```

If `resolve` rejects, for any reason, the attempt fails with
`Credential "<id>" could not be resolved`. The store's own error message is never recorded,
because it might contain secrets. A node whose config references credentials fails the same
way if the engine has no credential store.

## 2. Declare a credential field in a node type

Use the exported `credentialRef` schema for any config field that references a credential:

```ts
import { credentialRef, defineNodeType } from "antiflow";
import type { JsonValue } from "antiflow";
import { z } from "zod";

const slackPost = defineNodeType({
  type: "slack.post",
  version: 1,
  inputs: ["in"],
  outputs: ["out"],
  config: z.object({
    auth: credentialRef,
    channel: z.string(),
  }),
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

`credentialRef` is a strict `{ credentialId: string }` object. In `listNodeTypes()` it shows up
in the JSON Schema with the description _"A reference to a credential in the host's credential
store"_, so a UI can render a credential picker for it.

## 3. Reference it in a workflow

```json
{
  "id": "notify",
  "type": "slack.post@1",
  "config": { "auth": { "credentialId": "slack-workspace-acme" }, "channel": "#sales" }
}
```

The workflow definition, the snapshot and every record hold only `"slack-workspace-acme"`,
never the token.

**Any object in config shaped exactly `{ credentialId: string }` counts as a credential
reference**, wherever it is and whatever its schema says. That shape is reserved. All of a
node's references are resolved before each attempt, and the secrets are keyed by credential id
in `context.credentials`.

## Redaction

Before anything derived from an attempt leaves it, every resolved secret of that attempt is
masked:

- **log messages and fields** passed to `context.logger`
- **the handler's return value**, before it's persisted and before downstream nodes see it
- **the error message** of a failed attempt, in the node record and the `node:failed` event

What counts as a secret:

- Every **string or number leaf** of a resolved secret. For an object secret such as
  `{ user, password }`, each field counts on its own.
- Only secrets that are **at least 4 characters** as text. Masking shorter values would mangle
  ordinary text.

How it's masked:

- Each occurrence inside a string, raw or JSON-escaped, is replaced by `[redacted]`.
  Overlapping occurrences are merged.
- A number equal to a numeric secret becomes `"[redacted]"`.
- Object keys are redacted too.

```ts
context.logger.info(`calling with ${token}`, { header: `Bearer ${token}` });
// → info("calling with [redacted]", { header: "Bearer [redacted]", runId, nodeId, attempt })
```

### Limits

Matching is **exact**. A secret your handler transforms before it leaks (base64-encoded,
hashed, split, reversed, upper-cased) is **not** caught. Redaction is a safety net, not a
reason to log or return secrets. Don't put them in outputs or errors to begin with.
