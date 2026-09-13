# fiber-servo architecture plan

## Goal

`fiber-servo` is an experiment in using React Fiber as the control plane for a
small single-node container orchestrator.

The goal is **not** to turn JSX into YAML, and it is **not** to build a generic
OCI abstraction layer.

The core model is:

> React reconciles management resources. Controllers reconcile runtime
> resources. Runtime backends decide how those resources are realized.

```text
JSX
 ↓
React Fiber
 ↓
management resources / controllers
 ↓
runtime resource specs
 ↓
runtime backend
 ↓
container runtime

runtime events
 ↓
observed state
 ↓
controllers
```

There are two different reconciliation loops and they must remain separate:

```text
React reconciliation
  = desired control-plane configuration changed

controller reconciliation
  = observed runtime state differs from desired state
```

---

## Resource model

The initial resource hierarchy is:

```text
Deployment
    ↓
ReplicaSet
    ↓
Pod
    ↓
Container
```

`Network` and `Service` are resources referenced by Pods/workloads rather than
ownership parents.

### Controllers / management resources

Initially:

```text
Deployment
ReplicaSet
```

These represent policy and lifecycle management rather than concrete runtime
objects.

### Host/runtime resources

Initially:

```text
Network
Service
Pod
Container
```

These are materialized outside React.

The exact Host Component boundary may change while implementing this plan, but
the distinction between management resources and runtime resources should stay.

---

## Ownership is a tree; relationships are a graph

JSX parent/child nesting represents ownership/lifecycle where possible.
Cross-resource relationships should be explicit references.

Prefer:

```tsx
<>
  <Network name="backend" />

  <ReplicaSet replicas={3}>
    <Pod network="backend">
      <Container image="api:v1" />
    </Pod>
  </ReplicaSet>
</>
```

Ownership:

```text
ReplicaSet
  └─ Pod
      └─ Container
```

Reference:

```text
Pod ─────→ Network backend
```

Avoid using nesting only as configuration inheritance when it implies the wrong
resource ownership, for example a `ReplicaSet` appearing to be owned by a
`Network`.

---

## What React should reconcile

React should reconcile desired control-plane configuration.

For example:

```tsx
<ReplicaSet replicas={3} />
```

changing to:

```tsx
<ReplicaSet replicas={5} />
```

is a React reconciliation event.

Likewise, changing a Deployment Pod template from `api:v1` to `api:v2` is a
React reconciliation event.

React provides useful primitives for this layer:

```text
component identity
component lifecycle
state
hooks
composition
incremental desired-state updates
```

The experiment is to see whether these primitives make a useful control-plane
programming model outside UI rendering.

---

## Runtime events are not React diffs

If the desired state is:

```tsx
<ReplicaSet replicas={3} />
```

and one runtime Pod disappears:

```text
desired = 3
actual  = 2
```

the React tree did not change.

Do not manufacture a React prop update purely to trigger runtime recovery.

Instead:

```text
runtime event
 ↓
ObservedStateStore
 ↓
ReplicaSet controller
 ↓
desired = 3, actual = 2
 ↓
create one Pod
```

This replaces the current pattern where observed container death is converted
into a desired restart generation merely so React emits a runtime op.

---

## ReplicaSet

`ReplicaSet` is a controller over a Pod template.

```tsx
<ReplicaSet replicas={3}>
  <Pod network="backend">
    <Container image="api:v1" />
  </Pod>
</ReplicaSet>
```

Its desired state is approximately:

```text
replicas = 3
pod template = ...
```

Individual runtime Pod identities are not part of user intent.

```text
A B C
```

may become:

```text
A B D
```

without changing the ReplicaSet desired state.

---

## Deployment

`Deployment` manages generations of Pod templates and ReplicaSets.

```text
template v1
  ↓
ReplicaSet v1
  ↓
Pods v1
```

becoming:

```text
template v2
  ↓
ReplicaSet v2
  ↓
Pods v2
```

The first implementation only needs enough rollout behavior to demonstrate
that replacement policy belongs above individual runtime objects.

Do not start by reproducing full Kubernetes Deployment semantics.

---

## Pod

`Pod` is the execution/sandbox boundary.

```tsx
<Pod name="api" network="backend">
  <Container name="app" image="api:v1" />
  <Container name="sidecar" image="proxy:v1" />
</Pod>
```

Conceptually:

```text
Pod
├─ sandbox / network namespace
├─ shared networking
├─ shared volumes where applicable
├─ lifecycle boundary
│
├─ Container
└─ Container
```

Networking belongs primarily to the Pod sandbox, not independently to each
Container.

---

## Container and Pod immutability

Containers and Pods should be treated as immutable-ish resources.

Some runtime properties may support in-place updates, but that is an
implementation optimization rather than part of the React resource model.

Typical behavior:

```text
CPU / memory
  → may update in place

image / command / environment / rootfs / mount structure
  → replace Container

Pod sandbox / network namespace properties
  → replace Pod
```

React and controllers should operate on declarative resource specs. The runtime
backend decides whether a change means `noop`, in-place update, or replacement.

Low-level sequences such as:

```text
STOP
DELETE TASK
DELETE CONTAINER
CREATE CONTAINER
CREATE TASK
START
```

must remain below the runtime backend boundary.

---

## Runtime resource specs

Define small `fiber-servo` resource specs that describe orchestration intent,
not OCI or CRI protocol objects.

For example:

```ts
interface PodSpec {
  id: string;
  network?: string;
  labels?: Record<string, string>;
  containers: ContainerSpec[];
}

interface ContainerSpec {
  name: string;
  image: string;
  command?: string[];
  env?: Record<string, string>;
  resources?: Resources;
}
```

The exact types should evolve from real use cases.

Do not design them as wrappers around OCI specs, CRI protobufs, or Compose
schema objects.

---

## Runtime backend boundary

The orchestration boundary is the abstraction to preserve.

```text
React / Controllers
        ↓
fiber-servo Runtime API
        ↓
  ┌─────┴──────┐
  ↓            ↓
Compose       CRI
backend      backend
```

The Runtime API should stay intentionally small and resource-oriented.

Conceptually:

```ts
interface Runtime {
  createPod(spec: PodSpec): Promise<PodHandle>;
  removePod(id: string): Promise<void>;
  inspectPods(): Promise<ObservedPod[]>;
  subscribe(listener: RuntimeEventListener): () => void;
}
```

Additional operations should be introduced only when the resource model needs
them.

Do not mirror all of CRI, containerd, Compose, or OCI.

---

## First backend: Compose

The first implementation should be allowed to use Compose because it is the
smallest way to validate the React/controller architecture without first
building a CRI client, Pod sandbox implementation, and networking stack.

Conceptually:

```text
React / Controllers
        ↓
Runtime API
        ↓
Compose backend
        ↓
Compose Application Model
        ↓
nerdctl compose
        ↓
containerd
```

Compose is an **implementation backend**, not the control-plane model.

This distinction is important.

The project must not become:

```text
JSX
 ↓
full Compose YAML generation
 ↓
Compose owns all reconciliation
```

React/controller reconciliation happens above the backend. Compose only
realizes the runtime resources requested through the Runtime API.

The Compose backend may internally regenerate a whole Compose model and let
`nerdctl compose` perform its own application diff. That is acceptable because
it is a backend implementation detail, not the semantic reconciliation model
of `fiber-servo`.

This backend can also make `compose export` or debugging output easy later.

---

## Future backend: CRI

CRI is a possible later backend when the resource model needs more direct Pod
sandbox semantics than Compose can provide.

Possible architecture:

```text
fiber-servo (TypeScript)
        ↓
small Runtime API
        ↓
thin Go runtime daemon
        ↓
CRI
        ↓
containerd
```

TypeScript should not directly depend on CRI protobufs.

If implemented, the Go daemon should remain a protocol/runtime adapter only. It
must not contain ReplicaSet, Deployment, or Service controller logic.

Its job would be translating small `fiber-servo` runtime requests into CRI
operations such as:

```text
RunPodSandbox
CreateContainer
StartContainer
StopContainer
RemoveContainer
StopPodSandbox
RemovePodSandbox
```

Communication can initially be a Unix domain socket with a small JSON protocol.
Do not expose the whole CRI API through the daemon.

CRI is a backend choice, not part of the React resource model.

---

## OCI is not an abstraction goal

OCI compatibility is not a project-level abstraction target.

OCI belongs below runtime backends:

```text
Compose backend
  ↓
nerdctl
  ↓
containerd
  ↓
OCI runtime

or

CRI backend
  ↓
containerd
  ↓
OCI runtime
```

`fiber-servo` should not introduce generic APIs for cgroups, namespaces,
rootfs, bundles, OCI lifecycle commands, or runtime-spec fields merely to be
OCI-generic.

The rule is:

> Abstract the orchestration boundary, not the OCI boundary.

Choosing runc, youki, or another OCI runtime should generally remain a
containerd/backend concern.

---

## Network

Networking is intentionally single-node initially.

The target feature level is approximately a Docker user-defined bridge network.

```tsx
<Network name="backend" />
```

A Network represents approximately:

```text
local bridge
subnet
gateway
IP allocation
Pod attachments
```

A Pod references it:

```tsx
<Pod network="backend">
  ...
</Pod>
```

No initial support for:

```text
multi-node overlay networking
cluster routing
distributed IPAM
NetworkPolicy
```

The backend decides how the requested Network is implemented. A Compose backend
may map it to a Compose bridge network; another backend may implement the bridge
directly or through CNI/CRI.

---

## Service

A Service provides stable network identity over an ephemeral set of Pods.

```tsx
<Service
  name="api"
  selector={{ app: "api" }}
  port={80}
  targetPort={8080}
  publish={8080}
/>
```

Conceptually:

```text
host :8080
    ↓
Service api
    ↓
Pod A :8080
Pod B :8080
Pod C :8080
```

Direct host-port publishing is useful for simple workloads, but it does not
solve replicated workloads because multiple Pods cannot own the same host port.

`Service` therefore belongs in the orchestration model even though containerd
does not provide that concept directly.

### Service reconciliation

The controller observes Pods matching the selector and maintains the backend
set.

```text
selector = app=api

observed:
  Pod A app=api
  Pod B app=api
  Pod C app=api

service backends:
  A B C
```

If Pod C disappears, the Service controller updates the data plane to `A B`.
That is controller reconciliation, not a React diff.

Changing the Service configuration itself, such as `publish={8080}` to
`publish={9090}`, is a React desired-state change.

### Service data plane

Keep the Service control plane separate from packet forwarding.

Possible implementations include:

```text
proxy container
host userspace proxy
nftables
```

Start with the smallest implementation that works. A proxy container/daemon is
acceptable.

A Compose backend may realize Service using a proxy service/container while a
future runtime backend may use a different data plane without changing the
React API.

---

## Observed state

Runtime observations should enter an explicit store.

```text
runtime backend events
       ↓
ObservedStateStore
       ↓
controllers
```

At minimum the store should eventually represent:

```text
Pod existence/status
Container status
readiness where available
network addresses needed by Service
```

Controllers consume observed state. HostConfig should not translate observed
runtime events into fake React desired-state mutations.

---

## Why Compose is acceptable here

Compose was previously problematic when treated as the central model:

```text
React diff
 ↓
Compose model
 ↓
Compose diff
```

because that makes React look like an expensive JSX-to-YAML generator.

The revised architecture places Compose below the orchestration boundary:

```text
React Fiber
 ↓
management resources
 ↓
controllers
 ↓
runtime resources
 ==================== backend boundary
 ↓
Compose backend
 ↓
nerdctl
```

React still owns the meaningful control-plane configuration and controller
lifecycle. Compose is merely one way to materialize the resulting runtime
resources.

---

## Initial scope

Define the project initially as:

> A React-based single-node container orchestrator.

Initial controllers:

```text
ReplicaSet
Deployment
```

Initial runtime resources:

```text
Network
Pod
Container
Service
```

Initial runtime backend:

```text
Compose / nerdctl
```

Possible future backend:

```text
CRI / containerd
```

---

## Explicit non-goals

Do not implement initially:

```text
multi-node scheduling
cluster membership
distributed consensus
API server
etcd-like desired-state persistence
overlay networking
NetworkPolicy
distributed Service routing
Kubernetes API compatibility
full Kubernetes semantics
Docker Swarm compatibility
generic OCI runtime abstraction
```

The React/Fiber experiment must remain visible and understandable.

---

## Migration plan from the current implementation

### Phase 1 — Introduce resource specs and runtime boundary

Refactor the existing op/runtime interfaces so React no longer needs to encode
runtime lifecycle command sequences as the public semantic model.

Introduce the minimum declarative resource specs needed by current examples.

Do not remove working behavior before the replacement path is covered by tests.

### Phase 2 — Compose backend

Implement the first Runtime backend using Compose/nerdctl.

Map runtime resources to a Compose Application Model as needed.

Keep all Compose-specific schema and execution logic inside this backend.

### Phase 3 — Pod boundary

Introduce `Pod` as the execution/sandbox resource and make `Container` a child
resource inside it.

Preserve simple one-container workloads with ergonomic defaults where useful.

### Phase 4 — ObservedStateStore cleanup

Separate runtime observations from desired React mutations.

Move self-healing decisions out of `Container` restart-generation tricks and
into controller reconciliation.

### Phase 5 — ReplicaSet controller

Implement `ReplicaSet` using desired replica count + observed Pods.

Validate:

```text
desired = 3, actual = 2 → create one
desired = 2, actual = 3 → remove one
runtime Pod dies          → replace it without changing JSX
```

### Phase 6 — Network

Model a node-local bridge Network resource and Pod network references.

The Compose backend may initially map this directly to Compose networks.

### Phase 7 — Deployment

Implement Deployment on top of ReplicaSet/template generations.

Start with simple replacement. Add rolling behavior only after the controller
model is stable.

### Phase 8 — Service

Introduce stable Service endpoints over selected Pods.

Start with the simplest data-plane implementation, potentially a proxy
container/service under the Compose backend.

### Phase 9 — Evaluate backend limits

Only after the resource/controller model works, evaluate whether Compose is
blocking required semantics.

If so, add a CRI backend behind the same Runtime API rather than changing the
React model.

---

## Design rules

Keep these rules while implementing:

```text
React reconciles desired control-plane configuration.

Controllers reconcile observed runtime state.

Runtime events are not React diffs.

Do not manufacture React updates merely to restart runtime objects.

Deployment and ReplicaSet are controller abstractions.

Pod is the execution/sandbox boundary.

Container is a replaceable execution unit inside a Pod.

Network is initially a node-local bridge.

Service provides stable identity over ephemeral Pods.

Service control plane and data plane are separate.

Ownership is a tree.

Resource relationships are a graph.

Runtime-specific lifecycle command sequences stay below the backend boundary.

Compose is a backend, not the control-plane model.

CRI is a possible backend, not the control-plane model.

OCI compatibility is not an abstraction goal.

Abstract the orchestration boundary, not the OCI boundary.

Do not recreate Kubernetes unless the experiment requires it.
```

---

## Project definition

The project should remain explainable in one sentence:

> `fiber-servo` uses React Fiber as the control plane for a small single-node
> container orchestrator.

A more implementation-oriented description is:

> React reconciles management resources; controllers reconcile Pods and
> Services; runtime backends such as Compose or CRI materialize the resulting
> runtime resources.
