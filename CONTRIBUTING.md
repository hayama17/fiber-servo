# Contributing to fiber-servo

Read [Architecture](docs/architecture.md) before changing the control plane.

## Design rules

- React commits desired-state snapshots; hostConfig performs no runtime I/O.
- Observed container state lives outside the tree. Controllers compute
  desired runtime resources; the control loop owns backoff and rollout history.
- The runtime accepts a complete Compose model. containerd-specific code
  belongs in `src/runtime/containerd/`.

The reasons are recorded in [Design decisions](docs/decisions.md).

## Setup and checks

Node 20+ is required.

```sh
git clone https://github.com/hayama17/fiber-servo
cd fiber-servo
npm install
npm run check   # typecheck, formatting, tests, build
```

- Add or update tests in `test/` for behavior changes. Assert desired
  snapshots, plans, or runtime effects at the layer being changed.
- Use the memory runtime or fake `Nerdctl` and `ContainerdApi` interfaces
  for tests. The test suite requires no live containerd daemon.
- Run `npm run format` before committing; keep changes focused.

## Reporting bugs

Include the smallest reproducing tree, expected behavior, actual behavior,
and relevant logs. `collectSnapshots()` captures desired state;
`formatPlan()` formats planned changes.

For runtime bugs, include containerd and nerdctl versions. The
[adapter guide](docs/containerd.md) records known behavior; fake-runtime tests
do not replace verification against a live daemon.

## License

Contributions are licensed under the project's MIT License.
