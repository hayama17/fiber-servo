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
```

## Two rules that everything else depends on

1. **spec = fiber tree, status = external store.** Host instances are the
   desired state and nothing else. Whether a container is actually running
   lives outside the tree and is read with `useSyncExternalStore` (phase 1).
   Mixing the two would turn every runtime event into a tree mutation.
2. **commit executes nothing.** Every hostConfig method is synchronous and only
   appends to the op queue. `resetAfterCommit` hands the batch to a sink; the
   sink (a runtime) is the only place a side effect may happen. This keeps
   reconciliation testable without docker and keeps React's commit atomic.

## Layout

| Path | Role |
| --- | --- |
| `src/ops.ts` | `Op` types (`CREATE` / `UPDATE` / `DELETE`), spec diffing, formatting |
| `src/hostConfig.ts` | react-reconciler hostConfig. Only `container` host elements. Ops are pushed in `appendChild*` / `insertBefore*` (CREATE), `commitUpdate` (UPDATE), `removeChild*` / `clearContainer` (DELETE) |
| `src/reconciler.ts` | `createRoot({ sink })` with a synchronous `render()` / `unmount()`; `collectOps()` sink for tests |
| `src/components.tsx` | `Container` (renders the host element) and `Deployment` (stamps out keyed replicas named `${name}-${i}`) |
| `src/runtime/dummy.ts` | Phase-0 runtime: prints ops |
| `test/reconcile.test.tsx` | Fixes the op sequences for scale-up, scale-down, image change, rename, unmount, and the invariants |
| `examples/basic.tsx` | `npm run example` |

## Semantics fixed by tests

- `name` is identity. Ops refer to containers by name; renaming is `DELETE` + `CREATE`.
- Scaling a `Deployment` only touches the replicas that changed (keys are the replica index).
- `UPDATE` carries `prev`, `next`, and the list of changed spec keys. Equal props emit nothing.
- One batch per commit, delivered after the commit; nothing is observable mid-render.
- Nested containers: `CREATE` parents first, `DELETE` children first.
- Text nodes, unknown host elements, and duplicate names throw from `render()`.

## Roadmap

- **Phase 0 (this)**: hostConfig + dummy runtime, reconciliation verified without a runtime.
- **Phase 1**: status store + `useSyncExternalStore`; self-healing (`START` on `dead`), restart count and backoff, events injected from tests.
- **Runtime selection**: docker or containerd. Two files: one that executes ops, one that feeds events into the store.
- **Phase 2+**: composition (`<WebApp/>`), networking, dependency ordering with Suspense.

## Development

```sh
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run example   # print ops for a scale/update/teardown sequence
```
