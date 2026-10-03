# Security policy

## Supported versions

antiflow is in beta. Security fixes are made on `main` and released in the next version;
only the latest published version is supported.

| Version          | Supported |
| ---------------- | --------- |
| latest `0.x`     | Yes       |
| older versions   | No        |

## Reporting a vulnerability

**Please don't report security problems in public issues, discussions or pull requests.**

Report them privately through GitHub's private vulnerability reporting:

1. Go to the repository's [Security tab](https://github.com/shaheersystems-inc/antiflow/security).
2. Click **Report a vulnerability**.
3. Describe the problem, the affected version, and how to reproduce it. A minimal workflow
   definition and node types help a lot.

You should get a reply within 7 days. We'll keep you updated while a fix is prepared,
agree on a disclosure date with you, and credit you in the advisory unless you'd rather not
be named.

## Scope

antiflow is a library: it runs inside the host application and owns no server, queue or
network endpoint. Problems in how a host deploys it, or in third-party node types and
storage adapters, belong to those projects. Problems in antiflow's own code, including the
built-in nodes and the in-memory storage adapter, are in scope.

### Credentials and redaction

The most security-sensitive part of antiflow is credential handling. The engine resolves
`credentialRef` config fields through the host's credential store just before a handler
runs, and redacts the resolved secret values from everything it persists or emits: node
records, run events and logs.

A secret value reaching storage, events or logs **without** being transformed first is a
vulnerability. Please report it.

Redaction has documented limits that are **not** vulnerabilities: matching is exact, so a
secret a handler transforms before it leaks (encodes, hashes, splits, changes case) isn't
caught. See [Credentials → Limits](docs/site/guides/credentials.md#limits).
