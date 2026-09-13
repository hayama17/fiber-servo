# fiber-servo architecture plan

## Goal

`fiber-servo` is an experiment in using React Fiber as a **control plane for Compose**.

It intentionally sits between plain Compose and a full orchestrator such as Kubernetes:

```text
Compose
  = describe and apply a container application

fiber-servo
  = keep Compose applications under a continuous React-driven control loop

Kubernetes
  = distributed cluster control plane with scheduling, API persistence, networking,
    controllers, and many more production semantics
```

The goal is not to replace Compose, containerd, or OCI runtimes.
The goal is to add controller-style lifecycle management on top of Compose while
keeping React reconciliation meaningful.

A short description of the project is:

> **fiber-servo is a React control plane for Compose.**

Or, more explicitly:

> Compose describes how containers run. fiber-servo continuously manages how
> Compose applications should evolve.

---

## High-level architecture

```text
JSX
 ↓
React Fiber
 ↓
management resources / controllers
 ↓
concrete desired Compose applications
 ↓
Compose Application Model
 ↓
nerdctl compose
 ↓
containerd
 ↓
OCI runtime

runtime / Compose observations
 ↓
ObservedStateStore
 ↓
controllers
```

There are two different kinds of reconciliation:

```text
React reconciliation
  = desired control-plane configuration changed

controller reconciliation
  = observed runtime state differs from desired state
```

Compose performs its own application diff when a model is applied. That is an
execution detail below the fiber-servo control-plane boundary.

---

## Why Compose is the runtime boundary

Earlier designs treated Compose as only one possible backend beside CRI or raw
containerd. That creates abstraction pressure too early.

For now, Compose is the supported execution model.

This gives fiber-servo a clear scope:

```text
React Fiber
  ↓
controllers
  ↓
Compose applications
```

rather than:

```text
React Fiber
  ↓
generic orchestration model
  ↓
Compose / CRI / containerd / OCI / ...
```

Do not design a universal runtime abstraction unless a real second backend is
implemented later and proves that one is needed.

CRI, raw containerd, and direct OCI integration are explicitly deferred.

---

## React must remain meaningful

fiber-servo must not become only:

```text
JSX
 ↓
full Compose YAML generation
 ↓
nerdctl compose up
```

That would reduce React to a templating language.

React Fiber remains responsible for:

```text
component identity
component lifecycle
state
hooks
composition
incremental desired-state changes
controller lifecycle
```

For example:

```tsx
<ReplicaSet replicas={3}>...</ReplicaSet>
```

changing to:

```tsx
<ReplicaSet replicas={5}>...</ReplicaSet>
```

is a React reconciliation event.

A runtime container disappearing is not.

---

## Controllers reconcile reality

Suppose JSX still says:

```tsx
<ReplicaSet replicas={3}>...</ReplicaSet>
```

but one runtime instance disappears:

```text
desired = 3
actual  = 2
```

The React tree did not change.

Do not manufacture a fake React prop change merely to make the reconciler emit
an operation.

Instead:

```text
runtime observation
 ↓
ObservedStateStore
 ↓
ReplicaSet controller
 ↓
desired = 3, actual = 2
 ↓
update desired Compose application
 ↓
nerdctl compose
```

This is the core control loop.

> React reconciles intent. Controllers reconcile reality. Compose realizes it.

---

## Resource model

The initial management resources are:

```text
Deployment
ReplicaSet
Service
```

The initial execution/configuration resources are:

```text
Pod-like workload boundary (if needed)
Container
Network
Volume
```

These are not intended to reproduce Kubernetes APIs exactly.

Use Kubernetes concepts only where they clarify a problem that Compose alone
does not solve.

---

## Deployment and ReplicaSet

`ReplicaSet` maintains a desired number of workload instances.

Example:

```tsx
<ReplicaSet replicas={3}>
  <Container image="api:v1" />
</ReplicaSet>
```

Its semantic desired state is approximately:

```text
replicas = 3
template = api:v1
```

The controller decides which concrete Compose services/containers represent
those replicas.

For example:

```text
api-a
api-b
api-c
```

may later become:

```text
api-a
api-b
api-d
```

without changing the user's JSX.

`Deployment` manages template generations and rollout policy above ReplicaSet.
Start with simple replacement behavior. Do not reproduce the full Kubernetes
Deployment API.

---

## Pod-like grouping

Compose does not have a Kubernetes Pod primitive.

Do not force Kubernetes Pod semantics into the first implementation.

If a grouping primitive is useful, define only the semantics fiber-servo needs,
for example:

```text
shared lifecycle
shared network namespace where practical
multiple containers that should move together
```

The exact JSX/API should be decided from implementation pressure rather than by
copying Kubernetes.

A single-container workload must remain ergonomic.

---

## Container changes are immutable-ish

A container is not a DOM node. Many meaningful changes cannot be applied as a
small in-place mutation.

Therefore controller/runtime logic may treat changes as replacement.

Conceptually:

```text
old desired service/container
        ↓
new desired service/container
        ↓
Compose decides how to recreate/update runtime objects
```

Do not encode low-level lifecycle sequences such as:

```text
STOP
DELETE
CREATE
START
```

as the semantic output of React.

Those are execution details.

---

## Compose Application Model

The concrete state handed to the executor is a Compose Application Model.

fiber-servo may keep one or multiple Compose applications.

Conceptually:

```text
React Fiber
   ↓
Application / controller graph
   ├─ Compose Application A
   ├─ Compose Application B
   └─ Compose Application C
```

Multiple Compose applications are useful boundaries for lifecycle, ownership,
and isolation.

The important distinction is:

```text
React/controllers
  = decide what applications/resources should exist

Compose
  = describe and apply the concrete services/networks/volumes
```

---

## Ownership is a tree; relationships are a graph

Keep this rule:

> Ownership is a tree. Resource relationships are a graph.

For example, avoid using JSX nesting to imply ownership when the relationship is
only a network attachment.

Prefer an explicit reference:

```tsx
<>
  <Network name="backend" />

  <ReplicaSet replicas={3}>
    <Container image="api:v1" network="backend" />
  </ReplicaSet>
</>
```

rather than:

```tsx
<Network name="backend">
  <ReplicaSet replicas={3}>...</ReplicaSet>
</Network>
```

unless nesting intentionally means ownership.

---

## Network

Networking is intentionally single-node and Compose-like.

The target is roughly the temperature of a Docker user-defined bridge network.

Example:

```tsx
<Network name="backend" />
```

The Compose implementation may map this directly to a Compose bridge network.

Initial non-goals:

```text
multi-node overlay networking
cluster routing
distributed IPAM
NetworkPolicy
```

Do not build a CNI control plane.

---

## Service

Compose can publish ports, but a replicated workload needs a stable endpoint
that is independent from individual replica identity.

Therefore `Service` is useful as a fiber-servo management resource.

Example:

```tsx
<Service
  name="api"
  selector={{ app: "api" }}
  publish={8080}
  targetPort={8080}
/>
```

Conceptually:

```text
host :8080
    ↓
Service api
    ↓
replica A
replica B
replica C
```

The Service controller maintains the current backend set from observed workload
state.

The initial Compose implementation may realize this with a proxy container or
proxy service.

Keep control plane and data plane separate:

```text
React Service resource
        ↓
Service controller
        ↓
proxy configuration
        ↓
proxy container / daemon
```

Do not put packet forwarding logic inside React.

---

## Observed state

Observed runtime state must remain separate from desired React state.

Conceptually:

```text
nerdctl / containerd / Compose inspection
        ↓
ObservedStateStore
        ↓
ReplicaSet / Deployment / Service controllers
```

At minimum this eventually needs to answer questions such as:

```text
which replicas currently exist?
which are running/healthy?
which addresses/endpoints are available?
```

The current restart-generation pattern should be replaced where it exists only
to turn runtime failure into a fake React diff.

---

## Host components and controllers

Do not over-specify the Host Component boundary before implementation proves it.

The important semantic split is:

```text
controller / management concepts
  Deployment
  ReplicaSet
  Service

concrete Compose concepts
  service/container
  network
  volume
```

Some user-facing resources may be implemented as normal React components that
expand into lower-level host resources.

Prefer the smallest Host Config that keeps React reconciliation useful.

---

## OCI and CRI

OCI and CRI are not current abstraction goals.

The supported execution path is initially:

```text
fiber-servo
 ↓
Compose Application Model
 ↓
nerdctl compose
 ↓
containerd
 ↓
OCI runtime (runc / youki / ...)
```

OCI compatibility comes indirectly through the existing container stack.

Do not add generic APIs for OCI bundles, namespaces, cgroups, rootfs handling,
or runtime-spec fields merely to claim OCI support.

Likewise, do not build a TypeScript CRI client or Go CRI daemon now.

If Compose later becomes a real limitation, revisit the execution boundary with
concrete evidence from the controller/resource model.

---

## Initial project definition

Define the project as:

> **A React control plane for Compose.**

A useful longer description is:

> fiber-servo adds a continuous controller layer above Compose. React Fiber
> manages desired control-plane state; controllers maintain replicas, rollouts,
> and stable services; Compose remains the concrete container application and
> execution model.

This intentionally places fiber-servo between Compose and Kubernetes.

---

## Explicit non-goals

Do not implement initially:

```text
generic runtime backend abstraction
CRI integration
raw containerd orchestration
direct OCI runtime integration
Kubernetes API compatibility
full Kubernetes Pod semantics
multi-node scheduling
cluster membership
distributed consensus
API server / etcd-like persistence
overlay networking
NetworkPolicy
distributed Service routing
```

The project should remain small enough that the React/Fiber experiment stays
visible.

---

## Migration plan from the current implementation

### Phase 1 — Make Compose the execution boundary

Replace the current assumption that the semantic output of React is a list of
low-level runtime operations.

Introduce a Compose-oriented execution layer that can maintain the concrete
Compose Application Model required by the current desired state.

Keep working behavior covered by tests during migration.

### Phase 2 — Separate observed state from React diffs

Audit current self-healing behavior.

Move runtime failure handling away from patterns that artificially mutate React
props only to force `commitUpdate`.

Introduce/clean up an explicit ObservedStateStore consumed by controllers.

### Phase 3 — ReplicaSet controller

Refactor scaling/self-healing into a real ReplicaSet controller.

Validate:

```text
desired = 3, actual = 2 → create one replacement
desired = 2, actual = 3 → remove one
runtime instance dies     → restore desired count without changing JSX
```

### Phase 4 — Network model

Move network semantics toward explicit resource references rather than relying
on JSX ancestry as implicit membership.

Map the first implementation to Compose bridge networks.

### Phase 5 — Deployment

Implement template generations and basic rollout behavior above ReplicaSet.

Do not reproduce the full Kubernetes Deployment API.

### Phase 6 — Service

Refactor/extend the current proxy-based service behavior into an explicit
Service controller.

Keep the first data plane simple, likely a Compose-managed proxy container or
service.

### Phase 7 — Multiple Compose applications

Allow the control plane to own more than one Compose Application Model when that
provides useful lifecycle or isolation boundaries.

Do not introduce this abstraction before a concrete use case appears in the
implementation.

### Phase 8 — Re-evaluate the lower boundary

Only after the Compose-centered controller model is working, evaluate whether
Compose prevents an important capability.

If so, decide from evidence whether a lower backend such as CRI or raw
containerd is justified.

Do not pre-build that abstraction.

---

## Design rules

Keep these rules during implementation:

```text
React reconciles control-plane intent.

Controllers reconcile observed runtime state.

Runtime failures are not React diffs.

Compose is the supported execution model, not an intermediate accident.

Do not reduce the project to JSX -> YAML generation.

ReplicaSet owns replica-count reconciliation.

Deployment owns rollout/generation policy.

Service owns stable network identity over ephemeral replicas.

Ownership is a tree; resource relationships are a graph.

Keep networking single-node and bridge-oriented first.

Do not abstract CRI, containerd, or OCI before Compose proves insufficient.

Do not recreate Kubernetes unless a concrete Compose limitation requires the
missing concept.
```
