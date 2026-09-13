# Contributing to fiber-servo

Thanks for taking a look. This project is small and opinionated; the fastest way
to contribute is to understand the two rules it is built on, then keep them.

## The two rules

1. **spec = fiber tree, status = external store.** The tree describes what
   should exist. Whether it does is read from a `StatusStore` through
   `useSyncExternalStore`. Nothing in the tree writes status; nothing in the
   hostConfig reads it.
2. **commit executes nothing.** Every hostConfig method is synchronous and only
   appends an op. A runtime (the sink) executes ops later. If a change needs a
   side effect inside the reconciler, the design is wrong somewhere upstream.

A pull request that breaks either rule will be asked to find another shape,
even if it works. See [docs/architecture.md](docs/architecture.md) and
[docs/decisions.md](docs/decisions.md) for why.

## Setup

```sh
git clone https://github.com/hayama17/fiber-servo
cd fiber-servo
npm install
npm run check   # typecheck, format, tests, build
```

Node 20+ is required. containerd and nerdctl are only needed for the
`example:containerd` walkthrough; the test suite never touches a runtime.

## Making changes

- Add or update a test in `test/` for every behaviour change. The suite is the
  specification: op sequences are asserted literally, so a change in what the
  reconciler emits should show up as a diff in a test.
- Keep the reconciler runtime-agnostic. Anything that knows about containerd
  lives under `src/runtime/containerd/` and is driven through the `Nerdctl`
  interface so it can be tested with a fake.
- Run `npm run format` before committing; CI checks it.
- Keep commits focused. A commit message should say what changed and why, in
  that order.

## Reporting bugs

Open an issue with the smallest tree that reproduces the problem and the ops
(or nerdctl argv) you expected versus what you got. `collectOps()` and
`formatOp()` make this a few lines.

## Runtime verification

The containerd runtime is tested against a fake nerdctl. When you run it on a
real host, please report anything that differs from what
[docs/containerd.md](docs/containerd.md) assumes about nerdctl's output.
Those reports are the most valuable contribution right now.

## License

By contributing you agree that your contributions are licensed under the MIT
License, like the rest of the project.
