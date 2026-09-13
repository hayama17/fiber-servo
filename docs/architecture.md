# Architecture

fiber-servo is a custom React renderer. Instead of DOM nodes, the host
elements are containers and networks; instead of painting, a commit produces
a list of operations for a container runtime.

```
  JSX  ──render──▶  fiber tree  ──commit──▶  ops  ──sink──▶  runtime (containerd)
   ▲                                                              │
   └────────── useSyncExternalStore ◀── StatusStore ◀── events ───┘
```

## The two rules

Everything in the codebase follows from two decisions.

### 1. spec = fiber tree, status = external store

Host instances (`container`, `network`) are the desired state and nothing
else. Whether a container is actually running is a separate concern that lives
in a `StatusStore` outside the tree and is read with `useSyncExternalStore`.

- The tree never writes status. `<Container>` reads its own status to decide
  on a restart, but expresses that decision as a prop (`restarts`), which is
  desired state.
- The hostConfig never reads status. It only diffs props.

Mixing the two would turn every runtime event into a tree mutation and make
the reconciler impossible to test without a runtime.

### 2. commit executes nothing

Every hostConfig method is synchronous and only appends an op to the root's
`pending` list. `resetAfterCommit` hands that list to a sink. The sink is the
only place a side effect may happen.

- React's commit stays atomic and fast.
- Reconciliation is verified in tests by asserting op sequences.
- Swapping runtimes means writing a new sink, nothing else.

## Layers

| Layer      | Files                                                  | Knows about             |
| ---------- | ------------------------------------------------------ | ----------------------- |
| Components | `src/components.tsx`, `src/hooks.ts`                   | React, the status store |
| Reconciler | `src/hostConfig.ts`, `src/reconciler.ts`, `src/ops.ts` | Props and ops           |
| Status     | `src/status.ts`                                        | Nothing else            |
| Runtime    | `src/runtime/containerd/*`, `src/runtime/dummy.ts`     | Ops, the store, nerdctl |

The reconciler layer has no import from the runtime layer, and the runtime
layer has no import from the components layer.

## Data flow, step by step

### Mount

1. `root.render(<Deployment name="web" replicas={2}>…)` schedules a sync
   update and flushes it.
2. `Deployment` clones its template twice with keys `web-0`, `web-1`.
3. Each `Container` renders the `container` host element; `createInstance`
   builds an `Instance` with the spec extracted from props. No op yet: the
   render phase can be discarded.
4. Commit: `appendChildToContainer` places the instance and `mountSubtree`
   emits `CREATE` for it and any children, parents first.
5. `resetAfterCommit` passes the batch to the sink.

### Update

`commitUpdate` receives the new props, extracts the spec, diffs it against
the instance's spec and emits one `UPDATE` with the changed keys, or nothing.
If `name` changed, the instance is a different resource for the runtime:
`DELETE` old, `CREATE` new.

If the `restarts` prop advanced, one `START` is emitted with the new
generation as `attempt`.

### Self-healing

1. The runtime (or a test) calls `status.set('web-1', 'dead')`.
2. `useContainerStatus('web-1')` inside that container re-renders it.
3. `useSelfHeal` sees a death event it has not answered, arms a timer for
   `min(base × factor^n, max)`.
4. The timer sets state: generation `n + 1`, and records the event's `seq` as
   handled.
5. Re-render, `commitUpdate`, `START attempt=n+1`.
6. The runtime starts the container; the event watcher reports `running`.

A death is answered at most once. A second `START` waits for the store to
report another event.

### Dependency ordering

`useReady('db')` calls React's `use` on a thenable cached per store and id.
The thenable settles the first time the store reports `db` running. Until
then the component suspends and its `<Suspense>` boundary (wrapped by
`<Ready>`) shows nothing: no `CREATE` for the gated subtree. Once settled it
stays settled: ordering is a startup concern, liveness is self-healing's.

## Scheduling

All updates resolve to React's `SyncLane` (`resolveUpdatePriority` returns
the discrete priority), so a store event commits in the next microtask on its
own, and `root.flush()` commits it immediately. Suspense retries are the
exception: React picks a retry lane and goes through the Scheduler.
`root.settle()` waits for those.

React throttles the commit that replaces a Suspense fallback by about 300ms to
avoid flashing UI. The hostConfig's `scheduleTimeout` runs that on the next
microtask instead; there is nothing to flash.

## Ordering guarantees

- One batch per commit, delivered after the commit. Nothing is observable
  mid-render.
- Within a batch: deletions before placements (React's order), parents before
  children on `CREATE`, children before parents on `DELETE`.
- Across batches: the containerd executor runs them strictly in sequence.
