# fiber-servo

A React reconciler for containers. You write the desired state as JSX; React's
reconciliation turns changes into a list of operations; containerd runs them.

[![CI](https://github.com/hayama17/fiber-servo/actions/workflows/ci.yml/badge.svg)](https://github.com/hayama17/fiber-servo/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/fiber-servo)](https://www.npmjs.com/package/fiber-servo)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[日本語](README.ja.md)

```tsx
// app.tsx
import { Container, Deployment, Network } from 'fiber-servo';

export default function App() {
  return (
    <Network name="app">
      <Container name="db" image="postgres:16" readiness={{ exec: ['pg_isready'] }}>
        <Deployment name="web" replicas={2} service={{ port: 80, publish: 8080 }}>
          <Container image="nginx:alpine" env={{ DATABASE_HOST: 'db' }} />
        </Deployment>
      </Container>
    </Network>
  );
}
```

The tree shape is the topology: inside `<Network>` means membership, inside
`<Container>` means dependency. `fiber-servo plan app.tsx` shows what it
expands to without running anything:

```
CREATE network app
CREATE container db image=postgres:16 network=app
                                        (db reported ready)
CREATE container web-0 image=nginx:alpine network=app
CREATE container web-1 image=nginx:alpine network=app
CREATE container web image=docker.io/library/caddy:2-alpine network=app
```

`fiber-servo up app.tsx` runs it on containerd. Change `replicas` from 2 to
5 and exactly three `CREATE`s follow, plus an `UPDATE` of the proxy. Change
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

With the CLI, an app file is the whole program:

```sh
npx fiber-servo plan app.tsx              # print the ops, execute nothing
sudo npx fiber-servo up app.tsx           # run on containerd until Ctrl-C
sudo npx fiber-servo up app.tsx --watch   # ...and apply every save as a diff
```

There is no server to apply to: the file is the source of truth, and a
running `up` is its evaluation. Save the file and only what changed is
reconciled; containers that kept their name and spec are untouched. See
[docs/decisions.md](docs/decisions.md#18-no-api-server-the-file-is-the-source-of-truth)
for why.

From code, `serve()` is the same thing in one call:

```tsx
import { containerd, serve } from 'fiber-servo';

const served = serve(<App />, { runtime: containerd({ namespace: 'default' }) });
process.once('SIGINT', () => served.stop().then(() => process.exit(0)));
```

`examples/containerd.tsx` is this with logging; `examples/app.tsx` is the
tree it serves. The pieces behind `serve()` (`createRoot`,
`createContainerdRuntime`, `watchContainerd`) are exported for anything it
does not cover. See [docs/containerd.md](docs/containerd.md) for what the
runtime does with each op and what it assumes about nerdctl.

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

**Dependency ordering** is nesting. Children of a `<Container>` emit no
`CREATE` until it has been reported running, or `ready` when it declares a
`readiness={{ exec }}` probe that the runtime runs inside it. `<Ready
on="db">` does the same for dependencies that are not the parent. Under the
hood it is `use()` on a thenable that settles from the status store, inside
a `<Suspense>` boundary.

**Services** are composition. `<Service name="web" port={80} targets={[…]}>`
renders a caddy reverse proxy in front of its targets;
`<Deployment service={{ port, publish }}>` renders one for its replicas and
keeps its command in step with scaling. Host ports are published on the
proxy, so replicas never collide.

**Composition** is a function. `<App/>` is a component like any other.

More in [docs/architecture.md](docs/architecture.md) and
[docs/decisions.md](docs/decisions.md).

## API

See [docs/api.md](docs/api.md). The short version:

| Export                                                        | Role                                              |
| ------------------------------------------------------------- | ------------------------------------------------- |
| `serve(element, { runtime })`                                 | The one-call entry point; `stop()` tears down     |
| `containerd(options)`, `dummy(options)`                       | Runtimes for `serve()`                            |
| `Container`, `Deployment`, `Network`, `Service`, `Ready`      | The components                                    |
| `useContainerStatus`, `useReady`, `useSelfHeal`               | The hooks behind them                             |
| `createRoot({ sink, status })`                                | `render`, `flush`, `settle`, `unmount`, `liveIds` |
| `createStatusStore`                                           | The external store                                |
| `createNerdctl`, `createContainerdRuntime`, `watchContainerd` | containerd, piece by piece                        |
| `collectOps`, `formatOp`, `createDummyRuntime`                | Testing helpers                                   |

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
npx tsx src/cli.ts plan examples/app.tsx   # the CLI against the full example
sudo npm run example:containerd  # real containerd; kill a replica and watch it return
```

## Roadmap

- HTTP and TCP readiness probes, once there is a network path from the host
  into the CNI network.
- Volumes and resource limits as spec fields.
- A direct containerd gRPC client behind the same `Nerdctl` interface.

## Contributing

Issues and pull requests are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) first; the two rules above are enforced in
review. Reports from real containerd hosts are the most useful thing right
now.

## License

[MIT](LICENSE)
