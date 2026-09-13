# react4c

React reconciler for containers. The fiber tree is the desired state; the
reconciler's only output is a list of ops.

```tsx
import { Container, Deployment, createDummyRuntime, createRoot } from 'react4c';

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

## Two rules that everything else depends on

1. **spec = fiber tree, status = external store.** Host instances are the
   desired state and nothing else. Whether a container is actually running
   lives in a `StatusStore` outside the tree and is read with
   `useSyncExternalStore`. The tree never writes status, and the hostConfig
   never reads it. Mixing the two would turn every runtime event into a tree
   mutation.
2. **commit executes nothing.** Every hostConfig method is synchronous and only
   appends to the op queue. `resetAfterCommit` hands the batch to a sink; the
   sink (a runtime) is the only place a side effect may happen. This keeps
   reconciliation testable without docker and keeps React's commit atomic.

## How self-healing fits the two rules

The only thing the tree can say about status is a *desired restart
generation*. `<Container>` reads its status from the store; when it sees a
`dead` event it waits out the backoff and then renders `restarts={n + 1}`.
The hostConfig turns that prop change into one `START` op. Restart counting,
backoff, `maxRestarts`, and the reset after a stable run are all component
state, so they leave with the container and are testable with fake timers.

```tsx
<Container name="db" image="postgres" restart={{ baseDelayMs: 500, factor: 2, maxDelayMs: 60_000, maxRestarts: 10 }} />
<Container name="job" image="batch" restart="never" />
```

Every `status.set` is one event (its `seq` advances even for `dead` after
`dead`), a death is answered by at most one `START`, and the next `START`
waits for the store to report again. Everything updates on `SyncLane`, so a
store event commits in the next microtask, or immediately on `root.flush()`.

## Composition, networks, dependency ordering

```tsx
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

- **Composition** is a function. `<WebApp/>` expands to a network, a
  database and a deployment; scaling or bumping the image still touches
  only the replicas that changed.
- **`<Network>`** is the second host element. Containers rendered inside
  attach to it (an explicit `network` prop wins) and, on containerd, resolve
  each other by name. Tree nesting gives ordering: the network is created
  before its containers and deleted after them. Network fields other than
  `name` are immutable; changing one emits an `UPDATE` the containerd runtime
  refuses with a clear error.
- **`<Ready on="db">`** is dependency ordering with Suspense. `useReady`
  suspends on a thenable that settles the first time the status store reports
  the container `running`, so nothing inside emits a `CREATE` until then.
  Readiness is a latch: a later death of the dependency does not unmount
  dependents (self-healing handles it). React's Suspense retry goes through
  the Scheduler, so use `await root.settle()` rather than `root.flush()` when
  you need to observe it; the fallback-throttle React applies to UI (300ms)
  is short-circuited in the hostConfig because there is nothing to flash.

## Runtime: containerd

The reconciler talks to containerd through nerdctl, a thin CLI over
containerd's gRPC API that also brings CNI networking and port publishing
for phase 2. Two files connect it, and neither is known to the reconciler:

- `src/runtime/containerd/execute.ts` is the sink. Batches run strictly in
  order. `CREATE` inspects first: a container made from the same spec (a
  `react4c.spec` digest label) is adopted, a different one is recreated.
  `UPDATE` is `rm -f` + `run`. `START` is `nerdctl start`, or a fresh `run`
  if the container vanished. The executor writes only its own failures to
  the store: a refused `run` or `start` becomes `dead` with the reason, so the
  tree retries with backoff.
- `src/runtime/containerd/events.ts` is the event source. It reads `ps -a`
  at startup (and on every reconnect) to adopt existing containers, then
  follows `nerdctl events`: `/tasks/start` -> `running`, `/tasks/exit` of the
  init process -> `dead` with the exit code, `/containers/delete` -> forget.
  Only containers carrying the `react4c.managed` label are reported.

```tsx
const nerdctl = createNerdctl({ namespace: 'default' });
const status = createStatusStore();
const index = new Map<string, string>(); // containerd id -> name, shared by both files
const runtime = createContainerdRuntime({ nerdctl, status, index });
const root = createRoot({ status, sink: runtime.sink });
watchContainerd({ nerdctl, status, index, signal });
```

Restart policy is ours (`--restart=no`). `ports` are not published yet;
that is a networking decision for phase 2. Swapping nerdctl for a direct
gRPC client means replacing `nerdctl.ts`; the executor and watcher only see
`exec` and `stream`, which is also how the tests drive them.

## Layout

| Path | Role |
| --- | --- |
| `src/ops.ts` | `Op` types (`CREATE` / `UPDATE` / `DELETE` / `START`), spec diffing, formatting |
| `src/hostConfig.ts` | react-reconciler hostConfig. `container` and `network` host elements. CREATE on placement (parents first), UPDATE / START in `commitUpdate`, DELETE on removal (children first) |
| `src/status.ts` | `StatusStore`: per-id immutable snapshots, `subscribe`, `set` / `remove` |
| `src/hooks.ts` | `useContainerStatus` (the `useSyncExternalStore` read), `useSelfHeal` (death -> backoff -> generation), `useReady` (suspend until running once), `RestartPolicy` |
| `src/reconciler.ts` | `createRoot({ sink, status })` with synchronous `render()` / `flush()` / `unmount()`; `collectOps()` sink for tests |
| `src/components.tsx` | `Container`, `Deployment` (keyed replicas named `${name}-${i}`), `Network` (host element + context), `Ready` (Suspense boundary around `useReady`) |
| `src/runtime/dummy.ts` | Prints ops; with a store, reports CREATE / START as `running` and forgets on DELETE |
| `src/runtime/containerd/nerdctl.ts` | The only process spawner: `exec` and `stream` over `nerdctl` |
| `src/runtime/containerd/execute.ts` | Ops -> nerdctl argv, serialized; failures -> `dead` |
| `src/runtime/containerd/events.ts` | `ps -a` + `nerdctl events` -> status store |
| `test/containerd.test.tsx` | argv per op, adoption / recreate, ordering, event and `ps` parsing, end-to-end loop with a fake nerdctl |
| `test/reconcile.test.tsx` | Phase 0: op sequences for scale-up, scale-down, image change, rename, unmount, and the invariants |
| `test/self-heal.test.tsx` | Phase 1: `dead` -> `START`, backoff growth and cap, `never`, `maxRestarts`, reset, unmount cancels, store-driven re-render |
| `test/status-store.test.ts` | Store semantics |
| `test/phase2.test.tsx` | Phase 2: network ordering and membership, `Ready` gating / latch / multiple deps, `<WebApp/>` expansion |
| `examples/basic.tsx`, `examples/self-heal.tsx`, `examples/webapp.tsx` | `npm run example`, `npm run example:self-heal`, `npm run example:webapp` |
| `examples/containerd.tsx` | `npm run example:containerd` (needs containerd + nerdctl; not exercised in CI) |

## Semantics fixed by tests

- `name` is identity. Ops refer to containers by name; renaming is `DELETE` + `CREATE`.
- Scaling a `Deployment` only touches the replicas that changed (keys are the replica index).
- `UPDATE` carries `prev`, `next`, and the list of changed spec keys. Equal props emit nothing.
- One batch per commit, delivered after the commit; nothing is observable mid-render.
- Nested resources: `CREATE` parents first, `DELETE` children first. A `<Network>` is created before and deleted after its containers.
- Network and container names are separate namespaces; a network field other than `name` changing is an `UPDATE` the runtime may refuse.
- Nothing under `<Ready on>` emits `CREATE` until every listed container has been reported `running` once; readiness is a latch.
- `dead` in the store yields exactly one `START` per event, after `min(base * factor^n, max)`.
- A spec change and a restart landing in the same commit emit `UPDATE` then `START`.
- Text nodes, unknown host elements, and duplicate names throw from `render()`.

## Roadmap

- **Phase 0**: hostConfig + dummy runtime, reconciliation verified without a runtime. Done.
- **Phase 1**: status store + `useSyncExternalStore`; self-healing with restart count and backoff, events injected from tests. Done.
- **Runtime selection**: containerd, via nerdctl. Two files: one that executes ops, one that feeds events into the store. Done, verified against a fake nerdctl only; real-host verification is the next thing to run.
- **Phase 2**: composition (`<WebApp/>`), `<Network>` with name resolution, dependency ordering with Suspense (`<Ready>`). Done.
- **Next**: a `<Service>` that publishes a deployment under one name (a caddy `reverse-proxy --to web-0 --to web-1` container is the shortest path), readiness probes feeding a `ready` state into the store, and a real-host pass over the network and gating paths.

## Development

```sh
npm install
npm test                   # vitest
npm run typecheck          # tsc --noEmit
npm run example            # phase 0: scale / update / teardown
npm run example:self-heal  # phase 1: death -> START with backoff
npm run example:webapp     # phase 2: network + gated deployment, scale and update
sudo npm run example:containerd  # real containerd via nerdctl; kill a replica and watch it return
```
