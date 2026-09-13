# fiber-servo

A React reconciler for containers. You write the desired state as JSX; React's
reconciliation turns changes into a list of operations; containerd runs them.

[![CI](https://github.com/hayama17/fiber-servo/actions/workflows/ci.yml/badge.svg)](https://github.com/hayama17/fiber-servo/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/fiber-servo)](https://www.npmjs.com/package/fiber-servo)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[日本語](README.ja.md)

```tsx
import { Container, Deployment, Network, Ready } from 'fiber-servo';

function WebApp({ replicas, image }) {
  return (
    <Network name="app">
      <Container name="db" image="postgres:16" />
      <Ready on="db">
        <Deployment name="web" replicas={replicas}>
          <Container image={image} env={{ DATABASE_HOST: 'db' }} />
        </Deployment>
      </Ready>
    </Network>
  );
}
```

Render it, and the tree produces:

```
CREATE network app
CREATE container db image=postgres:16 network=app
                                        (db reported running)
CREATE container web-0 image=nginx network=app
CREATE container web-1 image=nginx network=app
```

Change `replicas` from 2 to 5 and exactly three `CREATE`s follow. Change
`image` and each replica gets one `UPDATE`. Kill `web-1` and, after a backoff,
`START container web-1 attempt=1`. Everything you know about React state,
composition and hooks applies to infrastructure.

> **Status: experimental.** The reconciler is covered by tests that never
> touch a runtime. The containerd runtime has been exercised on a real host
> but has not been through many hands yet. APIs may change before 1.0.

## Why

Container orchestrators reconcile a desired state against an observed state.
React does exactly that for UI, and its reconciler is pluggable. fiber-servo
plugs it into containerd, so the "control loop" is `render()`, composition is
a function call, and dependency ordering is Suspense.

## Install

```sh
npm install fiber-servo react
```

Node 20 or later. For a real runtime you need containerd and
[nerdctl](https://github.com/containerd/nerdctl) on the host; for development
and tests you need neither.

## Quick start without a runtime

```tsx
import { Container, Deployment, createDummyRuntime, createRoot } from 'fiber-servo';

const root = createRoot({ sink: createDummyRuntime() });

root.render(
  <Deployment name="web" replicas={3}>
    <Container image="nginx" />
  </Deployment>,
);
// -- commit #1 (3 ops)
//    CREATE container web-0 image=nginx
//    CREATE container web-1 image=nginx
//    CREATE container web-2 image=nginx

root.render(
  <Deployment name="web" replicas={5}>
    <Container image="nginx" />
  </Deployment>,
);
// -- commit #2 (2 ops)
//    CREATE container web-3 image=nginx
//    CREATE container web-4 image=nginx

root.status.set('web-1', 'dead'); // what a runtime's event stream would do
// ...1s of backoff later, on its own:
// -- commit #3 (1 op)
//    START container web-1 attempt=1
```

## Quick start on containerd

```tsx
import {
  createContainerdRuntime,
  createNerdctl,
  createRoot,
  createStatusStore,
  watchContainerd,
} from 'fiber-servo';

const nerdctl = createNerdctl({ namespace: 'default' });
const status = createStatusStore();
const index = new Map<string, string>();

const runtime = createContainerdRuntime({ nerdctl, status, index });
const root = createRoot({ status, sink: runtime.sink });
void watchContainerd({ nerdctl, status, index, signal: new AbortController().signal });

root.render(<WebApp replicas={2} image="nginx:alpine" />);
```

`examples/containerd.tsx` is a complete program. See
[docs/containerd.md](docs/containerd.md) for what the runtime does with each
op and what it assumes about nerdctl.

## Concepts

**Two rules hold everything together.**

1. **spec = fiber tree, status = external store.** Host elements are the
   desired state. Whether a container is running lives in a `StatusStore`
   outside the tree, read with `useSyncExternalStore`. The tree never writes
   status; the hostConfig never reads it.
2. **commit executes nothing.** Every hostConfig method is synchronous and
   only appends an op. A runtime consumes the batch after the commit. This is
   why the reconciler is testable without docker and why swapping runtimes is
   two files.

**Self-healing** is a desired restart generation. `<Container>` reads its
status, and when it sees a death it waits out an exponential backoff and
renders `restarts={n + 1}`; the reconciler emits `START`. Restart count,
`maxRestarts` and the reset after a stable run are component state.

```tsx
<Container name="db" image="postgres" restart={{ baseDelayMs: 500, maxDelayMs: 60_000, maxRestarts: 10 }} />
<Container name="job" image="batch" restart="never" />
```

**Networks** are the second host element. Containers inside a `<Network>`
attach to it and resolve each other by name. Tree nesting gives ordering.

**Dependency ordering** is `<Ready on="db">`: nothing inside emits a
`CREATE` until `db` has been reported running once. Under the hood it is
`use()` on a thenable that settles from the status store, inside a
`<Suspense>` boundary.

**Composition** is a function. `<WebApp/>` is a component like any other.

More in [docs/architecture.md](docs/architecture.md) and
[docs/decisions.md](docs/decisions.md).

## API

See [docs/api.md](docs/api.md). The short version:

| Export                                                        | Role                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `createRoot({ sink, status })`                                | `render`, `flush`, `settle`, `unmount`, `liveIds`           |
| `Container`, `Deployment`, `Network`, `Ready`                 | The components                                              |
| `useContainerStatus`, `useReady`, `useSelfHeal`               | The hooks behind them                                       |
| `createStatusStore`                                           | The external store                                          |
| `createDummyRuntime`                                          | Prints ops; optionally plays a runtime that always succeeds |
| `createNerdctl`, `createContainerdRuntime`, `watchContainerd` | containerd                                                  |
| `collectOps`, `formatOp`                                      | Testing helpers                                             |

## Development

```sh
npm install
npm test                   # vitest, no runtime needed
npm run typecheck
npm run build              # dist/
npm run check              # everything CI runs
npm run example            # scale / update / teardown
npm run example:self-heal  # death -> START with backoff
npm run example:webapp     # network + gated deployment
sudo npm run example:containerd  # real containerd; kill a replica and watch it return
```

## Roadmap

- `<Service>`: publish a deployment under one name. A caddy
  `reverse-proxy --to web-0 --to web-1` container built by composition is the
  shortest path.
- Readiness probes feeding a `ready` state into the store, so `<Ready>` can
  wait for "accepting connections" rather than "process started".
- Port publishing, once a Service decides what it means.
- A direct containerd gRPC client behind the same `Nerdctl` interface.

## Contributing

Issues and pull requests are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) first; the two rules above are enforced in
review. Reports from real containerd hosts are the most useful thing right
now.

## License

[MIT](LICENSE)
