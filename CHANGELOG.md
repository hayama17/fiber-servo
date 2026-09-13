# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Until 1.0, minor versions may
change public APIs.

## [Unreleased]

### Added

- `fiber-servo apply <app.tsx>`: explicitly re-evaluate a live local session,
  with serialized apply/watch requests, operation/error responses, and shutdown
  draining. `up` keeps edits pending unless `--watch` is selected.
- Reload local imports through a fresh esbuild bundle while sharing package
  dependencies. `serve().idle()` exposes the runtime queue drain.

- Nesting is dependency: children of a `<Container>` mount once it is
  running (or `ready`, when it has a `readiness` probe) and unmount before it.
- `serve(element, { runtime })`, the one-call entry point, with `dummy()` and
  `containerd()` runtimes.
- `fiber-servo` CLI: `plan <app.tsx>` prints every op without executing,
  `up <app.tsx>` runs the tree on containerd until Ctrl-C.
- `<Service>`: a caddy reverse proxy in front of named targets, built by
  composition; `<Deployment service={{ port, publish }}>` renders one for its
  replicas.
- `publish` on containers (`-p host:container[/udp]`).
- `readiness={{ exec }}` probes: the containerd runtime runs them with
  `nerdctl exec` and marks the store `ready`; `<Ready until="ready">`;
  `status.mark()`.
- `fiber-servo up --watch`: re-evaluate the app file on save and reconcile
  the difference; `--runtime dummy` to try it without containerd.
- Ops are reduced to their net effect per resource in each commit
  (`normalizeBatch`): a subtree remount that lands on the same names is an
  `UPDATE` or nothing, never a recreate. `DELETE` ops carry the last spec.

### Changed

- A `<Container>` inside another no longer produces a nested host instance;
  it is a dependent.
- `tsx` is a runtime dependency (the CLI loads TypeScript app files with it).

## [0.1.0] - 2026-09-13

First public release.

### Added

- Reconciler: `createRoot`, `Container`, `Deployment` with keyed replicas,
  `CREATE` / `UPDATE` / `DELETE` ops with per-key diffs, one batch per commit.
- Status store and `useContainerStatus`; self-healing with exponential
  backoff, `maxRestarts`, reset after a stable run, `restart="never"`.
- `START` op driven by a desired restart generation.
- containerd runtime through nerdctl: executor (adoption by spec digest,
  serialized batches, failures reported as `dead`) and event watcher
  (`ps -a` sync, `nerdctl events`).
- `<Network>` host element with name resolution on containerd.
- `<Ready on>` dependency ordering with Suspense; `root.settle()`.
- Dummy runtime, examples, and a test suite that never touches a runtime.

[Unreleased]: https://github.com/hayama17/fiber-servo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hayama17/fiber-servo/releases/tag/v0.1.0
