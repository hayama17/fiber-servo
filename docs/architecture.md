# Architecture

fiber-servo uses React Fiber as the control plane of a single-node container
orchestrator. This document explains the shape of the system and, more
importantly, **why there are two reconcilers in it and not one**.

## The one idea

```text
React reconciles management resources.
Controllers reconcile runtime resources.
```

Those are different jobs and they answer to different events:

```text
React reconciliation      = the desired configuration changed
                            (you edited the JSX, a hook returned something new)

Controller reconciliation = reality drifted from the desired configuration
                            (a Pod died, a machine rebooted, a container OOMed)
```

The temptation, when you have a reconciler as good as React's, is to make it do
both — to feed runtime failures back into the tree as props so that
`commitUpdate` fires and "React handles it". fiber-servo deliberately does not,
and the reason is in the next section.

## Why a Pod dying is not a React render

Consider:

```tsx
<ReplicaSet name="api" replicas={3}>
  <Pod labels={{ app: 'api' }}>
    <Container name="app" image="api:v1" />
  </Pod>
</ReplicaSet>
```

One Pod dies. What changed?

```text
desired = 3   <- unchanged. The JSX still says 3, and it is still correct.
actual  = 2   <- changed.
```

Nothing React can see is different. To make React notice, you would have to
invent a prop — a restart generation, a nonce — and change it _because_ a Pod
died. That prop is a lie: it encodes an observation as if it were an intention,
and once you have it you have two sources of truth about the same fact.

So instead the death is recorded in an **observed state** store, and a
**controller** compares 3 against 2 and creates one Pod. React renders zero
times. `examples/replicaset.tsx` prints the render count so you can watch this
happen.

This is also why the component is called `ReplicaSet` and takes `replicas`
rather than rendering three `<Pod>` children: it declares a _count_, not three
identities. A count stays true when a Pod dies.

## The pipeline

```text
   JSX
    │
    ▼
  React Fiber ──────────────► DesiredState        one snapshot per commit
    │                          (resources.ts)
    ▼
  controllers.ts ───────────► Pods + Networks     Deployment → ReplicaSet → Pod
    │                                              Service → proxy Pod
    ▼
  planner.ts ───────────────► Actions             noop / update / replace
    │
    ▼
  Runtime adapter ──────────► containerd          the only layer that knows
    │                                              stop/delete/create/start
    ▼
  runtime events
    │
    ▼
  observed.ts ──────────────► ObservedState ──────┐
                                                  │
                    controllers and planner read ─┘
```

Every stage is a pure function of its inputs except the last two, and the loop
is **level-triggered**: each pass reads the current desired state and the
current observed state and recomputes the difference from scratch. There is no
incremental diff being maintained, so there is nothing to get out of sync. A
missed event costs a late reconcile, never a wrong one.

`serve.ts` is the loop, and it is the only file that needs to understand both
halves.

## What each file is for

| File                  | Job                                                                     |
| --------------------- | ----------------------------------------------------------------------- |
| `resources.ts`        | The vocabulary. Specs — what should exist. No verbs.                    |
| `components.tsx`      | Six components, each a thin wrapper over one host element.              |
| `hostConfig.ts`       | React's commit becomes a `DesiredState` snapshot. No ops.               |
| `reconciler.ts`       | `createRoot`: render a tree, publish snapshots.                         |
| `hooks.ts`            | The read path from observed state into the tree.                        |
| `observed.ts`         | What is actually running. Written by adapters, read by controllers.     |
| `controllers.ts`      | Management resources become runtime resources. Pure.                    |
| `planner.ts`          | Desired vs observed becomes actions. Pure. Owns the immutability model. |
| `runtime/types.ts`    | The adapter contract.                                                   |
| `runtime/memory.ts`   | The reference adapter: the whole system runs without containerd.        |
| `runtime/containerd/` | The real adapter: nerdctl writes, containerd API reads, CNI networks.   |
| `serve.ts`            | The control loop, plus restart backoff.                                 |

## Ownership is a tree; relationships are a graph

Nesting in the JSX means **ownership**, and nothing else:

```text
Deployment
  └─ ReplicaSet          (created by the controller, not written by you)
      └─ Pod
          └─ Container
```

Everything else is a reference by name:

```tsx
<Network name="backend" />

<ReplicaSet name="api" replicas={3}>
  <Pod network="backend" labels={{ app: 'api' }}>   {/* joins by name */}
    <Container name="app" image="api:v1" />
  </Pod>
</ReplicaSet>

<Service name="api" selector={{ app: 'api' }} port={80} />  {/* selects by label */}
```

Writing `<Network><ReplicaSet/></Network>` would read as though the Network
owned the ReplicaSet, which it does not — it would also mean a Pod could only be
on a network its ancestors chose. (This reverses an earlier design where
`<Network>` ancestry _was_ membership; see decision 14.)

## The immutability model

Containers and Pods are mostly immutable. `planner.ts` owns the decision:

```text
container resources (cpu, memory)     → update in place
container image / command / env / …   → replace the container
pod network / publish / labels        → replace the Pod
network anything                      → replace the Network
pod observed as exited                → replace the Pod
```

Note the last line. A crash and an image change produce the _same_ action,
`replace-pod`, from the same function — which is what it looks like when
"desired state changed" and "reality drifted" are genuinely handled by one
mechanism instead of two.

Nothing above the adapter ever says `stop`, `delete` or `start`. The action is
`replace-pod`; that a replacement means remove-then-create is decided in
`serve.ts`'s `execute()` and carried out by the adapter, and that is the only
place the sequence exists.

## Where state lives

Four places, and the rule is which goes where:

1. **The fiber tree** — React's record of what it last committed, plus policy
   state (a `Ready` latch). React diffs against this, exactly as the DOM
   renderer diffs against memoized props and never re-reads the DOM.
2. **The runtime** — containerd. React never looks at it and assumes nothing
   about it.
3. **`observed.ts`** — the observation of 2. Because React cannot re-verify the
   host, drift has to come back as an _input_, and this is where it arrives.
4. **`serve.ts`'s restart gate** — how many times a Pod has already failed. The
   one piece of state the controllers and planner cannot hold, because they are
   pure functions of (desired, observed) and this is neither.

In Kubernetes terms, React plus the controllers are the part of a controller
that compares desired state against a cache, and `observed.ts` is the informer.

## Dependency ordering

`<Ready on="db" until="ready">` suspends its children until the `db` Pod is
observed running (or ready). This is the one place the tree reads observed
state, and it reads it to decide what to _want_ — which is legitimate, and
different from restating an observation as an intention.

It latches: a dependency that later dies does not retract what depends on it.
The planner will bring the dependency back, and unmounting its dependents in
the meantime would turn a blip into an outage.

## Running it without containerd

`runtime/memory.ts` implements the full adapter contract in memory. Because the
runtime boundary is declarative, the entire control plane — controllers,
planner, backoff, rollouts, Service endpoint resolution — runs against it
unchanged. That is what `fiber-servo plan` uses, and it is why almost the whole
test suite needs no container runtime at all.
