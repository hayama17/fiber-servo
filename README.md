# fiber-servo

**React Fiber as the control plane for a single-node container orchestrator.**

You describe containers, ReplicaSets and Services in JSX. React works out what
should exist. Controllers work out what to do about it. `nerdctl compose` runs
it, and containerd says what is actually alive.

```tsx
import { Container, Network, ReplicaSet, Service, containerd, serve } from 'fiber-servo';

serve(
  <>
    <Network name="backend" />

    <ReplicaSet name="api" replicas={3}>
      <Container image="api:v1" network="backend" labels={{ app: 'api' }} ports={[8080]} />
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

## Where it sits

```text
Compose          describes an application. No controller: it cannot count
                 replicas, roll out a generation, or bring a dead container back.

fiber-servo      the controllers, and a React tree to declare them in.
                 Hands the application to Compose.

Kubernetes       all of that, plus a cluster and everything that implies.
```

So fiber-servo does not create containers. It produces a **Compose application
model** and lets `nerdctl compose` apply it. There is no `createContainer`, no
`startTask`, no command line assembled from a spec anywhere in the project —
image resolution, networks and running processes are Compose's job, and they
were already solved.

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

Why that matters: suppose a container dies under `<ReplicaSet replicas={3}>`.

```text
desired = 3   <- unchanged. The JSX still says 3, and it is still right.
actual  = 2   <- changed.
```

React has nothing to re-render. The honest place to notice is a controller
comparing 3 against 2, and that is what happens — a dead container is replaced
with **zero React renders**. `examples/replicaset.tsx` prints the render count
so you can watch it not move.

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
npm run example            # one network, one container
npm run example:replicaset # kill a container, watch a controller replace it
npm run example:webapp     # database, rolled-out API, service in front
```

`fiber-servo plan` does the same thing for your own file, printing the Compose
model that would be applied and touching nothing:

```console
npx fiber-servo plan examples/app.tsx
```

## CLI

```console
fiber-servo plan  <app.tsx> [--model]           print what would be created; --model prints the Compose file
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
      └─ Container
```

**Props are references.**

```tsx
<Container network="backend" />      {/* joins a Network by name    */}
<Service selector={{ app: 'api' }} /> {/* selects containers by label */}
```

So this is right:

```tsx
<Network name="backend" />
<ReplicaSet name="api" replicas={3}>
  <Container image="api:v1" network="backend" />
</ReplicaSet>
```

and wrapping the ReplicaSet inside the `<Network>` would not be — a Network does
not own the containers that attach to it.

| Component      | What it is                                                           |
| -------------- | -------------------------------------------------------------------- |
| `<Network>`    | A local bridge network.                                              |
| `<Container>`  | One process and root filesystem. The unit of everything.             |
| `<ReplicaSet>` | "Keep N containers of this template alive."                          |
| `<Deployment>` | Rollout policy over ReplicaSets.                                     |
| `<Service>`    | A stable endpoint in front of whichever containers match a selector. |
| `<Ready>`      | Ordering: declare nothing inside until a container is up.            |

There is no Pod. An earlier version had one, emulated CRI-style out of an infra
container plus members sharing its network namespace — a thing neither
containerd nor Compose has, built and maintained by hand, in exchange for
sidecars that nothing here used. One container is one Compose service, and the
model is the smaller for it (decision 32).

### Immutability

```text
a container's spec differs in any field  → the container is replaced
a container observed as exited           → the container is replaced
```

A crash and an image change produce the same action from the same code path.
There is no in-place update — not even for cpu and memory, which earlier
versions did change on a live container. Compose has no live-update primitive,
and reaching past the actuator to mutate what it owns is the seam violation
this design exists to avoid, so raising a memory limit now restarts the
process (decision 34).

Nothing above the runtime adapter ever says `stop`, `delete` or `start`: the
adapter is handed the whole desired application and works out that a changed
service has to be evicted before Compose will recreate it.

### Services

A Service takes a **selector**, not a list of targets:

```tsx
<Service name="api" selector={{ app: 'api' }} port={80} targetPort={8080} publish={8080} />
```

The backend set is resolved from observed state, which is what lets replicas
come and go. It is also the answer to "why not publish a host port on each
replica": three replicas cannot each own port 8080, but one Service in front of
them can. The control plane and the data plane are separate — today the data
plane is a small proxy container, and replacing it with nftables would change
one function.

### Ordering

```tsx
<Container name="db" image="postgres:16"
           readiness={{ exec: ['pg_isready', '-U', 'postgres'] }} />

<Ready on="db" until="ready">
  <Container name="migrate" image="migrate:v1" />
</Ready>
```

Nothing inside `<Ready>` is declared until `db` reports ready. It latches: a
dependency that later dies does not retract what depends on it.

## How it fits together

```text
JSX → React Fiber → DesiredState → controllers → Compose model → nerdctl compose
                                        ▲                              │
                                        │                              ▼
                                        └──── observed state ◄──── containerd gRPC
```

The loop is level-triggered: every pass reads the current desired state and the
current observed state and recomputes the difference. A missed event costs a
late reconcile, never a wrong one.

Writes go down through Compose; reads come back from containerd underneath it.
That is not a layering violation — the two answer different questions. Compose
answers "did the application get applied"; containerd answers "is this process
alive right now, and with what exit code", which is the input a control loop
needs, as a stream, at a rate no CLI invocation can deliver.

[`docs/architecture.md`](docs/architecture.md) walks through it properly, and
[`docs/decisions.md`](docs/decisions.md) records why each choice was made.

## Non-goals

Multi-node scheduling, cluster membership, distributed consensus, API-server
persistence, overlay networking, NetworkPolicy, Kubernetes API compatibility.
Also, now: building anything Compose already has a word for. See
[`PLAN.md`](PLAN.md).

## Docs

- [`PLAN.md`](PLAN.md) — the architecture plan and what is still to build
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit
- [`docs/decisions.md`](docs/decisions.md) — why, one decision at a time
- [`docs/api.md`](docs/api.md) — the exported API
- [`docs/containerd.md`](docs/containerd.md) — the containerd adapter

## License

MIT
