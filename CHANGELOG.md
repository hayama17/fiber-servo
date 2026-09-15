# Changelog

## [Unreleased]

- React controller components now own ReplicaSet, Deployment, Service, and
  restart admission decisions.
- Runtime events flow through `useSyncExternalStore` and produce committed
  runtime resource snapshots.
- `serve.ts` remains the runtime I/O boundary and applies complete Compose
  models.
- The CLI supports explicit `apply` requests and optional file watching.

## [0.1.0] - 2026-09-13

First public release of the single-node Compose control-plane experiment.

[Unreleased]: https://github.com/hayama17/fiber-servo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hayama17/fiber-servo/releases/tag/v0.1.0
