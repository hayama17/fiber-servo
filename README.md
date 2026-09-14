# fiber-servo

**React Fiber as the control plane for a single-node container orchestrator.**

You describe Pods, ReplicaSets and Services in JSX. React works out what should
exist. Controllers work out what to do about it. containerd runs it.

```tsx
import { Container, Network, Pod, ReplicaSet, Service, containerd, serve } from 'fiber-servo';

serve(
  <>
    <Network name="backend" />

    <ReplicaSet name="api" replicas={3}>
      <Pod network="backend" labels={{ app: 'api' }}>
        <Container name="app" image="api:v1" ports={[8080]} />
      </Pod>
    </ReplicaSet>

    <Service
      name="api"
      network="backend"
      selector={{ app: 'api' }}
      port={80}
      targetPort={8080}
      publish={8080}
    />
  </>,
  { runtime: containerd() },
);
```

> **Status: an experiment.** Single node, no API server, no clustering. It is
> small on purpose — small enough that you can read it and see what React Fiber
> is actually contributing.

## The idea

There are two reconcilers here, and keeping them apart is the whole design:

```text
React reconciles management resources.      "I want three replicas of this."
Controllers reconcile runtime resources.    "There are two. Make another."
```

They answer to different events:

```text
React reconciliation      = the desired configuration changed
Controller reconciliation = reality drifted from it
```

Why that matters: suppose a Pod dies under `<ReplicaSet replicas={3}>`.

```text
desired = 3   <- unchanged. The JSX still says 3, and it is still right.
actual  = 2   <- changed.
```

React has nothing to re-render. The honest place to notice is a controller
comparing 3 against 2, and that is what happens — a dead Pod is replaced with
**zero React renders**. `examples/replicaset.tsx` prints the render count so you
can watch it not move:

```console
$ npm run example:replicaset
bringing up three replicas:
  create-pod api-0
  create-pod api-1
  create-pod api-2
  -> api-0:running api-1:running api-2:running
  React commits so far: 1

killing api-1 behind the control plane’s back:
  replace-pod api-1 because [phase]
  -> api-0:running api-2:running api-1:running
  React commits caused by the failure: 0 (the tree never changed)
```

The alternative — feeding the failure back into the tree as a changed prop so
`commitUpdate` fires — is what an earlier version of this project did, and it is
a lie: it encodes an observation as if it were an intention. Removing it is what
this architecture is for.

## Install

```console
npm install fiber-servo react
```

Node 20+. For the containerd runtime you need `nerdctl` on `PATH` and
permission to talk to containerd (usually `sudo`).

## Try it without containerd

The runtime boundary is declarative, so the entire control plane runs against an
in-memory adapter — controllers, rollouts, backoff, Service endpoints and all:

```console
npm run example            # one network, one pod
npm run example:replicaset # kill a pod, watch a controller replace it
npm run example:webapp     # database, rolled-out API, service in front
```

`fiber-servo plan` does the same thing for your own file, printing every action
and touching nothing:

```console
npx fiber-servo plan examples/app.tsx
```

## CLI

```console
fiber-servo plan  <app.tsx>                     print the actions, execute nothing
fiber-servo up    <app.tsx> [--watch]           run it on containerd until Ctrl-C
fiber-servo apply <app.tsx>                     re-evaluate the running session
```

`app.tsx` default-exports an element or a component. The file is the source of
truth — there is no API server to `apply` into. `--watch` re-evaluates on save;
`apply` does it on demand.

## The model

Six components. Two rules for reading them:

**Nesting is ownership.**

```text
Deployment
  └─ ReplicaSet     created by the controller; you never write one
      └─ Pod
          └─ Container
```

**Props are references.**

```tsx
<Pod network="backend">            {/* joins a Network by name  */}
<Service selector={{ app: 'api' }}> {/* selects Pods by label   */}
```

So this is right:

```tsx
<Network name="backend" />
<ReplicaSet name="api" replicas={3}>
  <Pod network="backend">…</Pod>
</ReplicaSet>
```

and wrapping the ReplicaSet inside the `<Network>` would not be — a Network does
not own the Pods that attach to it.

| Component      | What it is                                                            |
| -------------- | --------------------------------------------------------------------- |
| `<Network>`    | A local bridge network.                                               |
| `<Pod>`        | An execution sandbox: a network namespace and one or more containers. |
| `<Container>`  | One process and root filesystem inside a Pod.                         |
| `<ReplicaSet>` | "Keep N Pods of this template alive."                                 |
| `<Deployment>` | Rollout policy over ReplicaSets.                                      |
| `<Service>`    | A stable endpoint in front of whichever Pods match a selector.        |
| `<Ready>`      | Ordering: declare nothing inside until a Pod is up.                   |

### Pods

A Pod is the lifecycle boundary — the thing a ReplicaSet counts and a Service
routes to. Containers inside one share its network namespace and address:

```tsx
<Pod name="api" network="backend">
  <Container name="app" image="api:v1" />
  <Container name="sidecar" image="proxy:v1" />
</Pod>
```

Pod-level props define the sandbox, so they are immutable: changing `network`
replaces the Pod rather than moving it.

### Immutability

```text
container cpu / memory                → updated in place
container image / command / env / …   → the container is replaced
pod network / publish / labels        → the Pod is replaced
pod observed as exited                → the Pod is replaced
```

A crash and an image change produce the same action from the same function.
Nothing above the runtime adapter ever says `stop`, `delete` or `start`.

### Services

A Service takes a **selector**, not a list of targets:

```tsx
<Service name="api" selector={{ app: 'api' }} port={80} targetPort={8080} publish={8080} />
```

The backend set is resolved from observed state, which is what lets replicas
come and go. It is also the answer to "why not publish a host port on the Pod":
three replicas cannot each own port 8080, but one Service in front of them can.
The control plane and the data plane are separate — today the data plane is a
small proxy Pod, and replacing it with nftables would change one function.

### Ordering

```tsx
<Pod name="db">
  <Container name="postgres" image="postgres:16"
             readiness={{ exec: ['pg_isready', '-U', 'postgres'] }} />
</Pod>

<Ready on="db" until="ready">
  <Pod name="migrate">…</Pod>
</Ready>
```

Nothing inside `<Ready>` is declared until `db` reports ready. It latches: a
dependency that later dies does not retract what depends on it.

## How it fits together

```text
JSX → React Fiber → DesiredState → controllers → planner → Runtime adapter → containerd
                                        ▲                                        │
                                        └────────── observed state ◄─────────────┘
```

The loop is level-triggered: every pass reads the current desired state and the
current observed state and recomputes the difference. A missed event costs a
late reconcile, never a wrong one.

[`docs/architecture.md`](docs/architecture.md) walks through it properly, and
[`docs/decisions.md`](docs/decisions.md) records why each choice was made.

## Non-goals

Multi-node scheduling, cluster membership, distributed consensus, API-server
persistence, overlay networking, NetworkPolicy, Kubernetes API compatibility.
See [`PLAN.md`](PLAN.md).

## Docs

- [`PLAN.md`](PLAN.md) — the architecture plan and what is still to build
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit
- [`docs/decisions.md`](docs/decisions.md) — why, one decision at a time
- [`docs/api.md`](docs/api.md) — the exported API
- [`docs/containerd.md`](docs/containerd.md) — the containerd adapter

## License

MIT
