# Changelog

All notable changes to antiflow are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor versions
may contain breaking changes.

## [Unreleased]

## [0.1.0-beta.0]

The first beta: the v1 engine.

### Added

- `createEngine` with node type registration, `execute()`, live events and
  `listNodeTypes()` (config schemas as JSON Schema, ports and display metadata).
- Workflow validation that reports structured `ValidationIssue`s.
- Concurrent DAG execution with global and per-node-type concurrency caps.
- Branching and skip propagation, with optional input ports.
- Failure isolation, per-node timeouts and retry policies with fixed, exponential or custom
  backoff.
- Cancellation, immutable workflow snapshots and resume.
- The storage adapter interface, the in-memory adapter and the `antiflow/testing`
  conformance suite.
- Core nodes (If, Switch, Merge, Set, Delay) in `antiflow/nodes/core`.
- Credential references, credential stores and secret redaction.

[Unreleased]: https://github.com/shaheersystems-inc/antiflow/compare/v0.1.0-beta.0...HEAD
[0.1.0-beta.0]: https://github.com/shaheersystems-inc/antiflow/releases/tag/v0.1.0-beta.0
