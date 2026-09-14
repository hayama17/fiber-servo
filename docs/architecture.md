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
                            (a container died, a machine rebooted, a process OOMed)
```

The temptation, when you have a reconciler as good as React's, is to make it do
both — to feed runtime failures back into the tree as props so that
`commitUpdate` fires and "React handles it". fiber-servo deliberately does not,
and the reason is in the next section.

## Why a container dying is not a React render

Consider:

```tsx
<ReplicaSet name="api" replicas={3}>
  <Container image="api:v1" labels={{ app: 'api' }} />
</ReplicaSet>
```

One container dies. What changed?

```text
desired = 3   <- unchanged. The JSX still says 3, and it is still correct.
actual  = 2   <- changed.
```

Nothing React can see is different. To make React notice, you would have to
invent a prop — a restart generation, a nonce — and change it _because_ a
container died. That prop is a lie: it encodes an observation as if it were an
intention, and once you have it you have two sources of truth about the same
fact.

So instead the death is recorded in an **observed state** store, and a
**controller** compares 3 against 2 and asks for one more. React renders zero
times. `examples/replicaset.tsx` prints the render count so you can watch this
happen.

This is also why the component is called `ReplicaSet` and takes `replicas`
rather than rendering three `<Container>` children: it declares a _count_, not
three identities. A count stays true when a container dies.

## Three parties, and what each owns

The second idea, and the one that decides where the code boundaries are:

```text
fiber-servo   decides what should exist        React + controllers
nerdctl       makes it so                      compose up / rm / down
containerd    says what is actually running    Containers, Tasks, Events
```

fiber-servo never creates a container. It produces a **Compose application
model** — services, networks, labels — and hands the whole thing to the
actuator. There is no `createContainer`, no `startTask`, no argv built from a
spec anywhere above `src/runtime/`. Image resolution, network creation and
process supervision are Compose's, and were already solved.

Reads come from underneath, straight off containerd's gRPC API. That is not a
layering violation: Compose answers "did the application get applied", and
containerd answers "is this process alive right now, and with what exit code" —
which is the input a control loop needs, as a stream, at a rate no CLI can
deliver. See decisions 30 and 33.

## The pipeline

```text
   JSX
    │
    ▼
  React Fiber ──────────────► DesiredState        one snapshot per commit
    │                          (resources.ts)
    ▼
  controllers.ts ───────────► ContainerSpec[]     Deployment → ReplicaSet → Container
    │                          + NetworkSpec[]     Service → proxy container
    ▼
  compose.ts ───────────────► ComposeApplication  the whole desired application
    │
    ▼
  Runtime adapter ──────────► nerdctl compose     the only layer that knows
    │                                              rm / up / down
    ▼
  containerd gRPC ──────────► runtime events
    │
    ▼
  observed.ts ──────────────► ObservedState ──────┐
                                                  │
              controllers and the adapter read ───┘
```

Every stage is a pure function of its inputs except the last two, and the loop
is **level-triggered**: each pass reads the current desired state and the
current observed state and recomputes the model from scratch. There is no
incremental diff being maintained, so there is nothing to get out of sync. A
missed event costs a late reconcile, never a wrong one.

`serve.ts` is the loop, and it is the only file that needs to understand both
halves.

## What each file is for

| File                  | Job                                                                 |
| --------------------- | ------------------------------------------------------------------- |
| `resources.ts`        | The vocabulary. Specs — what should exist. No verbs.                |
| `components.tsx`      | Six components, each a thin wrapper over one host element.          |
| `hostConfig.ts`       | React's commit becomes a `DesiredState` snapshot. No ops.           |
| `reconciler.ts`       | `createRoot`: render a tree, publish snapshots.                     |
| `hooks.ts`            | The read path from observed state into the tree.                    |
| `observed.ts`         | What is actually running. Written by adapters, read by controllers. |
| `controllers.ts`      | Management resources become containers and networks. Pure.          |
| `compose.ts`          | Containers and networks become a Compose application. Pure.         |
| `planner.ts`          | What `plan` prints: the model, and how it differs from reality.     |
| `runtime/types.ts`    | The adapter contract: `apply`, `down`, `inspect`, `subscribe`.      |
| `runtime/memory.ts`   | The reference adapter: the whole system runs without containerd.    |
| `runtime/containerd/` | The real adapter: Compose writes, containerd API reads.             |
| `serve.ts`            | The control loop, plus restart backoff.                             |

## Ownership is a tree; relationships are a graph

Nesting in the JSX means **ownership**, and nothing else:

```text
Deployment
  └─ ReplicaSet          (created by the controller, not written by you)
      └─ Container
```

Everything else is a reference by name:

```tsx
<Network name="backend" />

<ReplicaSet name="api" replicas={3}>
  <Container image="api:v1" network="backend" labels={{ app: 'api' }} />
</ReplicaSet>

<Service name="api" selector={{ app: 'api' }} port={80} />
```

Writing `<Network><ReplicaSet/></Network>` would read as though the Network
owned the ReplicaSet, which it does not — it would also mean a container could
only be on a network its ancestors chose. (This reverses an earlier design
where `<Network>` ancestry _was_ membership; see decision 14.)

There is no Pod in that tree. An earlier design had one, emulated CRI-style out
of an infra container plus members sharing its namespace; it bought sidecars at
the price of maintaining by hand a thing neither containerd nor Compose has.
One container is one Compose service (decision 32).

## The immutability model

A container is immutable. Any difference at all between what is running and
what is wanted produces the same answer:

```text
container spec differs in any field    → the container is replaced
container observed as exited           → the container is replaced
network spec differs                   → Compose recreates the network
```

Two things are worth noticing. The first is that a crash and an image change
are handled by _the same_ mechanism — which is what it looks like when "desired
state changed" and "reality drifted" genuinely share one code path instead of
two.

The second is that there is no longer an in-place update. Earlier versions
changed cpu and memory on a live container, because containerd can. Compose has
no live-update primitive, and reaching past the actuator to mutate something it
believes it owns is exactly the seam violation this design is built to avoid.
Raising a memory limit now restarts the process; decision 34 records the
trade.

Because every difference has one answer, nothing needs to know _which_ field
moved. Each container carries a `fiber-servo.spec` label holding a digest of
the spec it was created from, and "same or different" is the whole question.

Nothing above the adapter ever says `stop`, `delete` or `start`. The adapter is
handed the complete desired application, and that a changed service must be
evicted before `compose up --no-recreate` will recreate it is decided there,
because that is the only layer that knows the actuator well enough to decide
it.

## Where state lives

Four places, and the rule is which goes where:

1. **The fiber tree** — React's record of what it last committed, plus policy
   state (a `Ready` latch). React diffs against this, exactly as the DOM
   renderer diffs against memoized props and never re-reads the DOM.
2. **The runtime** — containerd. React never looks at it and assumes nothing
   about it.
3. **`observed.ts`** — the observation of 2. Because React cannot re-verify the
   host, drift has to come back as an _input_, and this is where it arrives.
4. **`serve.ts`'s restart gate** — how many times a container has already
   failed. The one piece of state the controllers cannot hold, because they are
   pure functions of (desired, observed) and this is neither.

In Kubernetes terms, React plus the controllers are the part of a controller
that compares desired state against a cache, and `observed.ts` is the informer.

## Dependency ordering

`<Ready on="db" until="ready">` suspends its children until the `db` container
is observed running (or ready). This is the one place the tree reads observed
state, and it reads it to decide what to _want_ — which is legitimate, and
different from restating an observation as an intention.

It latches: a dependency that later dies does not retract what depends on it.
The controllers will bring the dependency back, and unmounting its dependents
in the meantime would turn a blip into an outage.

## Running it without containerd

`runtime/memory.ts` implements the full adapter contract in memory: it is a
Compose applier that keeps containers in a map, with the same idempotence the
real one has — a service whose digest is unchanged and whose container is alive
is left alone, keeping its id; anything else is replaced. Because the runtime
boundary is declarative, the entire control plane — controllers, backoff,
rollouts, Service endpoint resolution — runs against it unchanged. That is what
`fiber-servo plan` uses, and it is why almost the whole test suite needs no
container runtime at all.
