# fiber-servo architecture plan

## Goal

`fiber-servo` is an experiment in using React Fiber as the control plane for a
container application on one machine.

It sits deliberately between Compose and Kubernetes:

```text
Compose
  = describe a container application and apply it

fiber-servo
  = keep a Compose application under a continuous React-driven control loop

Kubernetes
  = a distributed control plane for a cluster
```

The important idea is not "JSX generates container configuration". It is:

> **React reconciles management resources. Controllers reconcile runtime
> resources.**

React Fiber owns identity, component lifecycle, state, and noticing that the
desired configuration changed. Controllers own noticing that reality drifted
from it. The two must not be mixed.

---

## Responsibility boundaries

Three parties, and each owns something the others do not touch.

```text
fiber-servo      orchestration semantics
                 React tree, hooks, lifecycle
                 ReplicaSet / Deployment / Service controllers
                 replica reconciliation, rollout policy, restart policy
                 observed state
                 -> decides which Compose application should exist

nerdctl compose  the actuator
                 image pull, container create/recreate/delete,
                 network create/attach, port publish, runtime configuration

containerd       the source of truth for actual runtime state
                 read over gRPC, never mutated by fiber-servo
```

The boundary that matters:

> **Writes go through nerdctl Compose. Reads go directly to containerd over
> gRPC.**

The seam is **who owns the resource**, not read-versus-write for its own sake.
Compose owns the application; containerd owns what is running. An earlier
revision of this plan split writes and reads as a principle and ended up
talking to one dependency three different ways — the CLI, gRPC, and nerdctl's
private CNI files — with an exception in its own headline rule. That is
recorded in `docs/decisions.md` rather than repeated here.

---

## Architecture

```text
                        desired path

JSX / React
     │
     ▼
React Fiber ─────────────► DesiredState        one snapshot per commit
     │
     ▼
Controllers ─────────────► Containers + Networks
     │
     ▼
Compose Application Model
     │
     ▼
nerdctl compose
     │
     ▼
containerd
     │
     │ gRPC: Containers / Tasks / Events
     ▼
ContainerdObserver
     │
     ▼
ObservedStateStore ──────► Controllers

                        observed path
```

Two different kinds of reconciliation meet in the control loop, and only
there:

```text
React reconciliation      = the desired configuration changed
Controller reconciliation = actual runtime state differs from it
```

The loop is **level-triggered**: every pass reads the current desired state
and the current observed state and recomputes from scratch. A missed event
costs a late reconcile, never a wrong one.

---

## Why a container dying is not a React render

```tsx
<ReplicaSet name="api" replicas={3}>
  <Container image="api:v1" />
</ReplicaSet>
```

One container dies.

```text
desired = 3   <- unchanged. The JSX still says 3, and it is still correct.
actual  = 2   <- changed.
```

Nothing React can see is different. Making React notice would mean inventing a
prop — a restart generation, a nonce — and changing it _because_ something
died. That prop encodes an observation as if it were an intention, and once it
exists there are two records of the same fact.

So the death is recorded in observed state, and a controller compares 3
against 2. React renders zero times. `examples/replicaset.tsx` prints the
render count so the claim can be checked rather than believed.

---

## Resource model

**Management resources** — policies, turned into containers by controllers:

```text
Deployment
ReplicaSet
```

**Runtime resources** — things that exist on the machine:

```text
Network
Container
Service
```

A container is the unit. A ReplicaSet counts containers, a Service routes to
containers, and one container becomes exactly one Compose service.

There is no Pod. An earlier revision made Pod a first-class sandbox, emulated
from an infra container plus members sharing its network namespace — building
by hand a thing neither containerd nor Compose provides. It bought sidecars,
which nothing used. If sidecars are wanted later, the honest way to get them
is CRI, which has sandboxes natively, and that is a different project.

### Ownership is a tree; relationships are a graph

```tsx
<Network name="backend" />

<ReplicaSet name="api" replicas={3}>
  <Container image="api:v1" network="backend" labels={{ app: 'api' }} />
</ReplicaSet>

<Service name="api" selector={{ app: 'api' }} port={80} targetPort={8080} />
```

Nesting is ownership and nothing else. A Network is joined by name; a Service
selects by label. Wrapping the ReplicaSet in the `<Network>` would read as
though the Network owned it, which it does not.

---

## Write path

fiber-servo decides _which Compose application should exist_, and stops there.

```text
Controllers
   ↓
Compose Application Model
   ↓
nerdctl compose
   ↓
containerd
```

`<ReplicaSet name="api" replicas={3}>` becomes, conceptually:

```yaml
services:
  api-0: { image: api:v1 }
  api-1: { image: api:v1 }
  api-2: { image: api:v1 }
```

Image pulling, container creation, network attachment and starting are the
actuator's. fiber-servo holds no `CREATE_CONTAINER` / `START_TASK` vocabulary
in its control-plane model.

### What applying actually does

`nerdctl compose up` is **not** idempotent — it recreates every container even
when the model has not changed, which in a level-triggered loop would churn
the application for ever. Measured against nerdctl 2.1.2, applying is
therefore two steps:

```text
1. for each service whose recorded spec digest differs from the model's:
       nerdctl compose rm -f -s <service>
2. nerdctl compose up -d --no-recreate
```

Step 2 alone creates what is missing and starts what has stopped — self-
healing comes free. Step 1 is what makes a changed spec take effect.

Deciding step 1's list is the one piece of diffing fiber-servo keeps: it
compares the desired spec's digest against the `fiber-servo.spec` label read
back from containerd.

---

## Read path

`nerdctl ps`, `nerdctl inspect` and `nerdctl events` are not used to observe.
A `ContainerdObserver` connects to containerd's gRPC API directly:

```text
containerd
   │ unix socket / gRPC
   ▼
ContainerdObserver
   ▼
ObservedStateStore
   ▼
controllers
```

Services used, all read-only:

```text
Containers.List / Containers.Get     identity, image, labels
Tasks.List / Tasks.Get               running state, exit status
Events.Subscribe                     lifecycle events
```

Why the API rather than the CLI: there is no text to parse, no process spawn
per read, and events arrive as typed messages with a container id and an exit
status in fields rather than as lines to interpret.

### containerd is read-only

fiber-servo must never call a containerd mutation RPC:

```text
Containers.Create / Update / Delete
Tasks.Create / Start / Kill / Delete / Update
image pull, snapshot creation, namespace creation
```

Anything that needs one goes through the Compose model instead.

### Namespace and socket

The containerd namespace that `nerdctl compose` writes into and the one the
observer reads from **must be the same**, and must come from one place in the
configuration. The write and read paths never derive it separately. The socket
path is configurable and never hardcoded — rootless containerd puts it
elsewhere.

---

## Observed state

Runtime changes are not React diffs.

```text
runtime event
 ↓
ObservedStateStore
 ↓
controllers
 ↓
desired 3 vs actual 2
 ↓
a new Compose model, applied
```

Observed state feeds controllers. It is never converted into a fake
desired-state mutation.

---

## Networking

Single node, bridge only, at roughly the feature level of a Docker
user-defined network.

```tsx
<Network name="backend" />
```

Networks are Compose's to create, attach and remove; fiber-servo only declares
them in the model. Not in scope: overlay networking, multi-node routing,
NetworkPolicy, a cluster-wide CNI control plane.

---

## Service

Several replicas cannot share a host port, so external exposure needs a
Service:

```tsx
<Service name="api" selector={{ app: 'api' }} port={80} targetPort={8080} publish={8080} />
```

```text
host :8080
    ↓
Service
    ↓
api-0  api-1  api-2
```

```text
ReplicaSet  = compute reconciliation
Service     = network endpoint reconciliation
```

The backend set is resolved from observed state, not from a prop, because
containers come and go without the tree changing. Control plane and data plane
are separate: today the data plane is a small proxy container in the same
model, and replacing it with nftables would change one function.

---

## Explicit non-goals

```text
multi-node scheduling
cluster membership
distributed consensus
API server persistence
overlay networking
NetworkPolicy
Kubernetes API compatibility
full Kubernetes semantics
Pod semantics and sidecars
```

The project should stay small enough that the React/Fiber experiment remains
visible.

---

## Design rules

```text
React reconciles management resources.

Controllers reconcile runtime resources.

Runtime events are observed state, not React diffs.

Writes go through nerdctl Compose. Reads go directly to containerd.

containerd is an observed-state API, never a mutation API.

fiber-servo does not decompose work into low-level runtime operations.

A container is the unit. One container is one Compose service.

Ownership is a tree. Resource relationships are a graph.

Namespace is configured once and shared by both paths.

Service control plane and data plane are separate.

Do not recreate Kubernetes unless the experiment requires it.
```

The project should remain understandable as:

> React Fiber used as the control plane for a Compose application on one
> machine.
