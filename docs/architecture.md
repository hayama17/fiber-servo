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

### Where state lives

The fiber tree does hold state: the state it last committed. Render compares
the new desired tree with that record and emits the difference. This is how
React works for the DOM too: it never reads the DOM back, it diffs against
its own memoized props and assumes the DOM is what it wrote.

The part that plays the real DOM here is containerd. The difference is that
a DOM only changes when React changes it, while a container can die on its
own. React has no mechanism to re-verify its host, so containerd's actual
state is tracked separately, in the status store, and fed back into the tree
as an input next to props. The tree turns that observation into a new
intention (`restarts={n + 1}`), and React diffs the intention against its
record as usual.

| Place                         | Holds                                                                          | Who reads it                           |
| ----------------------------- | ------------------------------------------------------------------------------ | -------------------------------------- |
| Fiber tree and host instances | What was last committed, plus policy state (restart counters, `Ready` latches) | Render, to diff                        |
| containerd                    | What actually exists                                                           | Nobody in the tree                     |
| Status store                  | The observation of containerd                                                  | Components, via `useSyncExternalStore` |

A process restart loses the first row. The runtime's `fiber-servo.spec`
labels let `CREATE` adopt what exists, the watcher's initial `ps -a` refills
the store, and the restart counters start over. One fiber-servo process per
set of containers is assumed; two would each keep their own record and
fight.

## Layers

| Layer      | Files                                                  | Knows about               |
| ---------- | ------------------------------------------------------ | ------------------------- |
| Components | `src/components.tsx`, `src/hooks.ts`                   | React, the status store   |
| Reconciler | `src/hostConfig.ts`, `src/reconciler.ts`, `src/ops.ts` | Props and ops             |
| Status     | `src/status.ts`                                        | Nothing else              |
| Runtime    | `src/runtime/containerd/*`, `src/runtime/dummy.ts`     | Ops, the store, nerdctl   |
| Hosting    | `src/serve.ts`, `src/daemon/*`, `src/cli.ts`           | Roots, runtimes, a socket |

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

`useReady('db')` calls React's `use` on a thenable cached per store, id and
condition. The thenable settles the first time the store reports `db`
running (or `ready`, when the dependent asks for it). Until then the
component suspends and its `<Suspense>` boundary (wrapped by `<Ready>`)
shows nothing: no `CREATE` for the gated subtree. Once settled it stays
settled: ordering is a startup concern, liveness is self-healing's.

`<Container>` applies this to its own children: they are rendered inside a
`<Ready on={name}>` ahead of the host element, so the tree shape expresses
the dependency, dependents mount after the container is up, and React
deletes them before it on unmount. A container with a `readiness` probe
gates on `ready`; the containerd runtime's prober runs the probe with
`nerdctl exec` and `mark()`s the store.

### Entry point

`serve(element, { runtime })` binds a runtime to a fresh status store,
starts its watcher, renders, and gives back `stop()`. The `fiber-servo` CLI
is two commands over it: `plan` uses the dummy runtime, which reports every
`CREATE` as running and ready, so the full expansion prints without a
runtime; `up` uses containerd. There is no API server, because there is no
desired state to store: `app.tsx` is a program and what runs is the tree it
evaluates to. `up --watch` re-evaluates it on save (decisions 18 and 21).

A reloaded file exports a new component function, so React remounts the
subtree: DELETE then CREATE for every name in it. `resetAfterCommit` reduces
each commit to its net effect per `kind:name` before handing it to the sink
(`normalizeBatch`), so the runtime sees an `UPDATE` where the spec changed
and nothing where it did not (decision 19).

### Daemon

`serve()` is one evaluation of one program. `fiber-servo daemon` hosts
several: one runtime, one status store, one executor queue, one event watcher
and one readiness prober, and one React root per applied app. The pieces are
shared because container names are global on the host; the roots are separate
because each app is its own tree.

```
  apply app.tsx ──path──▶ daemon ──import──▶ element tree ──render──▶ root_n ──▶ ops
  delete app.tsx ────────▶          one runtime, one store, N roots        ──▶ runtime
```

What crosses the socket is a path, never a tree. The daemon keeps the
_evaluation_, which is what the status store feeds: a death has to become
`restarts={n + 1}`, and that is a render, so it needs a live component tree.
A serialized tree would be one frozen evaluation and nothing downstream of it
could respond to an observation (decision 21).

| Layer    | File                     | Holds                                       |
| -------- | ------------------------ | ------------------------------------------- |
| Protocol | `src/daemon/protocol.ts` | NDJSON framing, request and response types  |
| Server   | `src/daemon/server.ts`   | App registry, socket handling, shutdown     |
| Client   | `src/daemon/client.ts`   | Connect, send one request, stream the reply |

An app's id is the resolved absolute path of its file, so `apply` on a known
id is a re-render (React diffs; only the difference reaches the runtime) and
`delete` unmounts one root. Every mutation runs on one queue: applies share
the store, the executor and the prune keep set, which is the union of every
root's `liveIds` (decision 20). `apply --watch` moves the watching into the
daemon, so a client attaches only for the first reconcile. On shutdown the
daemon unmounts every app, drains the runtime, stops the watcher and unlinks
the socket.

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
