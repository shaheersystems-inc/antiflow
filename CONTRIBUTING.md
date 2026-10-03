# Contributing to antiflow

Thanks for your interest in antiflow. This guide covers how to set up the repo, the ground
rules the code follows, and how changes get proposed and merged.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a
security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Development setup

You need [Bun](https://bun.sh) (the dev/build/test tool; the library itself runs on any
JavaScript runtime).

```bash
bun install
bun test               # all tests
bun test test/engine.test.ts         # one file
bun test -t "passes each node's output"  # one test by name
bun run typecheck
bun run build          # compile src/ to dist/ (what gets published)
```

CI runs `bun run typecheck` and `bun test` on every pull request; both must pass before a
PR can merge.

## Repository layout

- `src/index.ts` — the public API. Everything a host imports comes from here.
- `src/engine.ts`, `src/planner.ts`, `src/runner.ts`, `src/scheduler.ts`, … — the engine
  internals.
- `src/nodes/core/` — the `antiflow/nodes/core` entry point: the built-in If, Switch, Merge,
  Set and Delay nodes.
- `src/testing/` — the `antiflow/testing` entry point: the storage adapter conformance suite.
- `test/` — the test suite.
- `docs/site/` — the user documentation, written to be published as the docs site.
- `docs/design/workflow-engine-design.md` — the design record: every architectural decision
  and the reasoning behind it.
- `CONTEXT.md` — the domain vocabulary.
- `.agents/`, `.claude/`, `docs/agents/` — configuration for the AI coding agents used on
  this repo. You don't need them to contribute.

## Ground rules

These keep antiflow a small, embeddable library. A PR that breaks one needs a design change
first (see below).

- **Runtime-agnostic.** No Bun-only (or Node-only) APIs in `src/`. Bun is only the dev tool.
- **The core ships no node implementations.** The engine and registration API live in the
  core entry point; the built-in nodes live behind `antiflow/nodes/core` and use only the
  public API. Integration nodes (HTTP, third-party APIs) belong in their own packages.
- **No owned services.** No HTTP server, job queue, cron or scheduler process. The host
  supplies storage and decides when to call `execute()`.
- **Test through the public API.** Tests drive the engine through `src/index.ts` (and the
  other entry points) using fake node types defined in the test, not by reaching into
  internals.
- **Use the domain vocabulary.** Name things with the terms in [`CONTEXT.md`](CONTEXT.md)
  (and avoid the synonyms it lists) in code, tests, issues and docs.
- **Execution is at-least-once.** Don't add behaviour that assumes a handler runs exactly
  once.

## Design changes

[`docs/design/workflow-engine-design.md`](docs/design/workflow-engine-design.md) is the
source of truth for how antiflow works and why, including what v1 deliberately leaves out
(cycles and loops, sub-workflows, per-item data, inline code nodes, templating in config,
distributed execution).

If your change alters one of those decisions, open an issue to discuss it first. When it's
agreed, update the design record in the same PR as the code.

## Documentation

If a change affects behaviour a user can see (API, events, records, validation issues,
node behaviour), update the matching pages in [`docs/site/`](docs/site/index.md) in the same
PR, and add an entry under **Unreleased** in [`CHANGELOG.md`](CHANGELOG.md).

## Issues

- **Bugs**: use the bug report template and include a minimal workflow definition and the
  node types needed to reproduce it.
- **Features**: use the feature request template and explain how the request fits the v1
  scope in the design record.
- **Questions**: ask in [Discussions](https://github.com/shaheersystems-inc/antiflow/discussions),
  not issues.

New issues get the `needs-triage` label. A maintainer then labels them (`bug`,
`enhancement`, `documentation`, …) or closes them (`duplicate`, `invalid`, `wontfix`).
Issues labelled `good first issue` or `help wanted` are good places to start.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make the change, with tests. Keep a PR to one logical change.
3. Run `bun run typecheck` and `bun test`.
4. Open a PR against `main` and fill in the template, linking the issue it resolves
   (`Closes #123`).

Every change to `main` goes through a pull request, and the CI check must pass. Review
conversations must be resolved before merging.

**Commit messages**: a short summary line in the imperative mood ("Add Switch default
port", not "Added…"), then a blank line and a body explaining why, if it isn't obvious.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers the project.
