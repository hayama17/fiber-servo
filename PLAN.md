# fiber-servo architecture plan

## Goal

`fiber-servo` is an experiment in using React Fiber as the control plane for a
**single-node container orchestrator**.

The important idea is not "JSX generates container configuration". The
important idea is:

> **React reconciles management resources. Controllers reconcile runtime
> resources.**

React Fiber stays responsible for identity, component lifecycle, state, and
detecting changes in the desired control-plane configuration. The runtime layer
is responsible for realizing Pods and Containers.

---

## Overall architecture

```text
JSX
 ↓
React Fiber
 ↓
Management Resources
 ↓
Controllers
 ↓
Runtime Resources
 ↓
Runtime Adapter
 ↓
containerd

containerd/runtime events
 ↓
Observed State
 ↓
Controllers
```

There are two different kinds of reconciliation:

```text
React reconciliation
  = desired control-plane configuration changed

Controller reconciliation
  = actual runtime state differs from desired state
```

These must not be mixed.

---

## Core principle

Do not translate React commits directly into low-level runtime operations such
as:

```text
STOP
DELETE
CREATE
START
```

React should not know how a runtime applies a resource change. React and
controllers operate on declarative resource specifications instead:

```ts
type ContainerSpec = {
  image: string;
  command?: string[];
  env?: Record<string, string>;
  resources?: Resources;
};
```

The runtime adapter decides whether a change means:

```text
noop
update in place
replace container
replace pod
```

The low-level operation sequence remains an implementation detail of the
runtime adapter.

---

## Resource model

### Management resources

These represent policies and controllers rather than concrete runtime objects.
Initially:

```text
Deployment
ReplicaSet
```

They are normally implemented as React components plus controller logic:

```tsx
<ReplicaSet replicas={3}>
  <Pod network="backend">
    <Container image="api:v1" />
  </Pod>
</ReplicaSet>
```

A ReplicaSet represents:

```text
desired replicas = 3
pod template = ...
```

It does **not** represent three fixed container identities. If one runtime Pod
disappears:

```text
desired = 3
actual = 2
```

the ReplicaSet controller creates another Pod. The React tree itself does not
need to change.

### Host resources

Host resources are materialized outside React. Initially:

```text
Network
Pod
Container
Service
```

Ownership runs:

```text
Deployment / ReplicaSet
        ↓
       Pod
        ↓
    Container
```

Network and Service are graph relationships rather than ownership
relationships.

---

## Ownership vs references

> **Ownership is a tree. Resource relationships are a graph.**

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

The ownership relationship is:

```text
ReplicaSet
  └─ Pod
      └─ Container
```

The network relationship is:

```text
Pod ───────→ Network backend
```

Do not force all resource relationships into JSX parent/child nesting. Avoid:

```tsx
<Network name="backend">
  <ReplicaSet ... />
</Network>
```

because that makes the ReplicaSet look owned by the Network. This reverses the
current implementation, where `<Network>` is a host element whose JSX ancestry
means membership (see decision 14); membership becomes an explicit reference.

---

## Pod model

`Pod` is a first-class runtime boundary: an execution sandbox containing one or
more Containers.

```tsx
<Pod name="api" network="backend">
  <Container name="app" image="api:v1" />
  <Container name="sidecar" image="proxy:v1" />
</Pod>
```

```text
Pod
├─ sandbox
├─ network namespace
├─ shared networking
├─ shared volumes where applicable
├─ lifecycle boundary
│
├─ Container
└─ Container
```

Pod-level properties determine the sandbox. Container-level properties
determine processes and root filesystems inside that sandbox.

---

## Immutability model

Containers and Pods are treated as mostly immutable resources. Do not model
every runtime property as an in-place mutation:

```text
CPU / memory
  → potentially update in place

image / command / environment / rootfs
  → replace Container

sandbox/network namespace properties
  → replace Pod
```

The runtime adapter owns this decision:

```text
old ContainerSpec
      ↓
planner
  ┌───┴────┐
update   replace
```

Replacement strategy belongs above the individual runtime object:

```text
Container
  = replaceable execution unit

ReplicaSet
  = maintains a number of Pods

Deployment
  = manages rollout between Pod template generations
```

This avoids leaking runtime-specific `stop/delete/create/start` sequences into
React.

---

## Observed state

Runtime changes are not React diffs. Given:

```tsx
<ReplicaSet replicas={3} />
```

if one Pod dies:

```text
desired = 3
actual = 2
```

the JSX and the fiber props have not changed. So do **not** force a React
update by artificially changing values such as a restart generation purely to
trigger `commitUpdate`. Instead:

```text
runtime event
 ↓
Observed State / StatusStore
 ↓
ReplicaSet controller
 ↓
desired 3 vs actual 2
 ↓
create one Pod
```

Observed state feeds controller logic; it is not converted into fake
desired-state mutations. This supersedes the `restarts` host prop and the
`START` op that `useSelfHeal` drives today (decision 6).

---

## Runtime layer

The runtime layer receives declarative Pod/Container specifications and
realizes them. Roughly:

```ts
interface Runtime {
  createPod(spec: PodSpec): Promise<PodHandle>;
  removePod(id: string): Promise<void>;

  createContainer(podId: string, spec: ContainerSpec): Promise<ContainerHandle>;
  removeContainer(id: string): Promise<void>;

  inspect(): Promise<ObservedState>;
  subscribe(listener: RuntimeEventListener): Unsubscribe;
}
```

The exact API is not fixed. The constraint is:

> **React does not emit runtime command sequences.**

---

## containerd / CRI direction

Pod support makes CRI a potentially useful runtime boundary. CRI already has:

```text
RunPodSandbox
StopPodSandbox
RemovePodSandbox

CreateContainer
StartContainer
StopContainer
RemoveContainer
```

Using CRI could avoid implementing Pod sandbox and network lifecycle directly
on top of raw containerd. This decision stays behind the Runtime abstraction;
the React resource model must not depend on CRI. Possible implementations:

```text
CriRuntime
RawContainerdRuntime
```

Start with whichever gives the smallest correct implementation.

---

## Networking

Networking is intentionally limited to single-node behavior, roughly at the
feature level of a Docker user-defined bridge network.

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

Do not implement, for the first version:

```text
overlay networking
multi-node routing
NetworkPolicy
cluster-wide CNI control plane
```

A Pod references a Network:

```tsx
<Pod network="backend">...</Pod>
```

Networking belongs to the Pod sandbox, not to individual Containers by
default.

---

## External exposure / Service

External exposure is needed. Direct host-port publishing on a Pod may be
supported as a minimal mechanism, but it does not solve the ReplicaSet case:
several Pods cannot all own the same host port. Hence a Service abstraction:

```tsx
<Service name="api" selector={{ app: 'api' }} port={80} targetPort={8080} publish={8080} />
```

```text
host :8080
    ↓
Service
    ↓
Pod A :8080
Pod B :8080
Pod C :8080
```

Responsibilities:

```text
ReplicaSet
  = compute reconciliation

Service
  = network endpoint reconciliation
```

A Service observes the current Pods matching its selector and maintains the
backend set. Note the difference from today's `<Service>`, which takes an
explicit `targets` list computed by `<Deployment>` at render time (decision
16): selection becomes an observed-state query, not a render-time array.

### Service data plane

Separate the Service API from its implementation. React exposes:

```tsx
<Service ... />
```

but the backing implementation is replaceable:

```text
proxy container
host userspace proxy
nftables
```

For the first implementation, a proxy container or a small proxy daemon is
acceptable:

```text
React Service resource
        ↓
Service Controller
        ↓
proxy configuration
        ↓
fiber-servo proxy
        ↓
matching Pod IPs
```

Do not make React itself responsible for packet forwarding. The Service is
control plane; the proxy is data plane.

---

## React host components

The likely initial split:

```text
React Components / Controllers
├─ Deployment
└─ ReplicaSet

Host Resources
├─ Network
├─ Service
├─ Pod
└─ Container
```

This may evolve during implementation. The key distinction:

```text
normal React Component
  = policy / abstraction / controller logic

Host Component
  = resource materialized outside React
```

---

## Why not Compose

Compose was considered as an intermediate representation. It is useful as a
container application model, but making Compose the primary runtime boundary
introduces another diff/application layer:

```text
React diff
 ↓
Compose model
 ↓
compose up
 ↓
Compose performs another diff
```

That weakens the value of using React reconciliation. `fiber-servo` should not
become:

```text
JSX → Compose YAML generator
```

React must remain meaningful as the control-plane reconciler. Compose may still
be supported later as an export format or an optional backend, but it is not
the core architecture. This replaces the previous revision of this plan, which
made Compose the execution boundary.

---

## Initial scope

A React-based single-node container orchestrator.

Initial concepts:

```text
Network
Pod
Container
ReplicaSet
Deployment
Service
```

Initial runtime:

```text
containerd
```

potentially through CRI.

Initial networking:

```text
local bridge only
```

Initial Service implementation:

```text
simple proxy / host forwarding backend
```

---

## Explicit non-goals

For now, do not implement:

```text
multi-node scheduling
cluster membership
distributed consensus
API server persistence
overlay networking
NetworkPolicy
Kubernetes API compatibility
full Kubernetes semantics
Swarm compatibility
```

The project should stay small enough that the React/Fiber experiment remains
visible.

---

## Implementation order

1. Refactor the current runtime boundary so React no longer emits low-level
   lifecycle command sequences. Today `src/hostConfig.ts` pushes
   `CREATE`/`UPDATE`/`DELETE`/`START` ops directly from commit; the boundary
   becomes a declarative desired-resource set instead.
2. Introduce declarative `PodSpec` / `ContainerSpec` types, alongside the
   existing `ContainerSpec` in `src/ops.ts`.
3. Introduce a Runtime abstraction that accepts specs rather than ops. The
   current `Runtime`/`RuntimeHandle` in `src/serve.ts` is an op sink; it grows
   an apply/inspect/subscribe shape.
4. Implement Pod and Container as runtime resources, with the Pod as the
   sandbox boundary and the Container inside it.
5. Move actual-state feedback into an explicit observed-state path. The status
   store (`src/status.ts`) is already outside the tree; what changes is that
   controllers, not `useSelfHeal`, consume it — retiring the `restarts` prop
   and the `START` op.
6. Implement ReplicaSet as a controller using desired replicas plus observed
   Pods, replacing the render-time replica expansion in `<Deployment>`.
7. Implement the local bridge Network, with Pod attachment as an explicit
   reference rather than JSX ancestry.
8. Implement Deployment rollout semantics on top of ReplicaSet.
9. Introduce Service as a stable endpoint over matching Pods, selected from
   observed state.
10. Implement the first Service data plane using the simplest practical proxy
    mechanism.

Keep working behavior covered by tests at each step.

---

## Design rules

Keep these rules while implementing:

```text
React reconciles management resources.

Controllers reconcile runtime resources.

Runtime events are observed state, not React diffs.

Containers and Pods are immutable-ish.

Replacement strategy belongs to controllers/runtime adapters.

Ownership is a tree.

Resource relationships are a graph.

Networking is Pod-scoped.

Service control plane and data plane are separate.

Do not recreate Kubernetes unless the experiment requires it.
```

The project should remain understandable as:

> React Fiber used as the control plane for a small single-node container
> orchestrator.
