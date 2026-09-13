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

## Layout

| Path | Role |
| --- | --- |
| `src/ops.ts` | `Op` types (`CREATE` / `UPDATE` / `DELETE` / `START`), spec diffing, formatting |
| `src/hostConfig.ts` | react-reconciler hostConfig. Only `container` host elements. CREATE on placement, UPDATE / START in `commitUpdate`, DELETE on removal |
| `src/status.ts` | `StatusStore`: per-id immutable snapshots, `subscribe`, `set` / `remove` |
| `src/hooks.ts` | `useContainerStatus` (the `useSyncExternalStore` read), `useSelfHeal` (death -> backoff -> generation), `RestartPolicy` |
| `src/reconciler.ts` | `createRoot({ sink, status })` with synchronous `render()` / `flush()` / `unmount()`; `collectOps()` sink for tests |
| `src/components.tsx` | `Container` (renders the host element) and `Deployment` (stamps out keyed replicas named `${name}-${i}`) |
| `src/runtime/dummy.ts` | Prints ops; with a store, reports CREATE / START as `running` and forgets on DELETE |
| `test/reconcile.test.tsx` | Phase 0: op sequences for scale-up, scale-down, image change, rename, unmount, and the invariants |
| `test/self-heal.test.tsx` | Phase 1: `dead` -> `START`, backoff growth and cap, `never`, `maxRestarts`, reset, unmount cancels, store-driven re-render |
| `test/status-store.test.ts` | Store semantics |
| `examples/basic.tsx`, `examples/self-heal.tsx` | `npm run example`, `npm run example:self-heal` |

## Semantics fixed by tests

- `name` is identity. Ops refer to containers by name; renaming is `DELETE` + `CREATE`.
- Scaling a `Deployment` only touches the replicas that changed (keys are the replica index).
- `UPDATE` carries `prev`, `next`, and the list of changed spec keys. Equal props emit nothing.
- One batch per commit, delivered after the commit; nothing is observable mid-render.
- Nested containers: `CREATE` parents first, `DELETE` children first.
- `dead` in the store yields exactly one `START` per event, after `min(base * factor^n, max)`.
- A spec change and a restart landing in the same commit emit `UPDATE` then `START`.
- Text nodes, unknown host elements, and duplicate names throw from `render()`.

## Roadmap

- **Phase 0**: hostConfig + dummy runtime, reconciliation verified without a runtime. Done.
- **Phase 1**: status store + `useSyncExternalStore`; self-healing with restart count and backoff, events injected from tests. Done.
- **Runtime selection**: docker or containerd. Two files: one that executes ops, one that feeds events into the store.
- **Phase 2+**: composition (`<WebApp/>`), networking, dependency ordering with Suspense.

## Development

```sh
npm install
npm test                   # vitest
npm run typecheck          # tsc --noEmit
npm run example            # phase 0: scale / update / teardown
npm run example:self-heal  # phase 1: death -> START with backoff
```
