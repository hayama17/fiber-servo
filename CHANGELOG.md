# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Until 1.0, minor versions may
change public APIs.

## [Unreleased]

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
