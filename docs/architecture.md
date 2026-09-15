MethodException: 
Line |
   2 |  … chitecture.md')); $s=$s.Replace(([char]13+[char]10),[char]10); [Conso …
     |                      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
     | Cannot convert argument "oldChar", with value: "
", for "Replace" to type "System.Char": "Cannot convert value "
" to type "System.Char". Error: "String must be exactly one character long.""
# Architecture

React commits desired resources. Controller components subscribe to observed
containers and render the runtime resources that should exist. The runtime
adapter applies the committed snapshot through `nerdctl compose` and reads
container state through containerd gRPC.

```text
JSX → React Fiber + controller components → runtime DesiredState → Compose model → Runtime.apply
                                      ▲                             │
                                      └── ObservedState ◄── containerd gRPC
```

A container dying does not change `replicas={3}`. The control loop restores
the desired count without requiring a React render. Components that explicitly
subscribe through hooks can still render on observations; `<Ready>` uses this
to declare dependent resources after startup.

## Responsibilities

| Layer           | Responsibility                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| React renderer  | Resource identity, component state, one `DesiredState` snapshot per commit; no runtime I/O.                                      |
| Controllers     | React components that subscribe to observations and render runtime resources; pure expansion helpers remain reusable underneath. |
| Control loop    | Schedule reconciliation, retain rollout templates, apply restart backoff, and skip empty plans.                                  |
| Runtime adapter | Apply the whole Compose model, inspect containers, and publish observations.                                                     |
| nerdctl Compose | Create, start, replace, and remove application resources.                                                                        |
| containerd gRPC | Read container identity, task state, and lifecycle events. No mutation RPCs.                                                     |

See [the adapter guide](containerd.md) for the apply sequence and connection
options. The namespace and socket are shared by the read and write paths;
`serve({ project })` supplies the Compose project.

## Resource model

One Container maps to one Compose service. ReplicaSet and Deployment own a
Container template; Deployment creates ReplicaSets through its controller.

```text
Deployment
  └─ ReplicaSet
      └─ Container
```

Nesting means ownership. Other relationships use props: `network="backend"`
joins a Network, `selector={{ app: 'api' }}` selects Service backends, and
`<Ready on="db">` gates startup. Network, Container, and Service have no
children. There is no Pod resource.

- **Container:** any spec change, including CPU or memory, replaces it.
  An exited container with an unchanged spec is restarted by the adapter.
- **ReplicaSet:** keeps deterministic names, `<name>-<index>`, as it scales.
- **Deployment:** uses the full template digest as generation identity and a
  short digest in names. It shifts replicas within the rollout strategy's
  bounds while the old templates remain in memory.
- **Service:** selects running containers by label. It does not filter by
  readiness or network membership; backends must be reachable from the proxy.
  Its Caddy proxy targets service names. No matching endpoints means no proxy;
  backend changes replace the proxy and can interrupt traffic. This is an
  accepted tradeoff to keep the experiment small.
- **Ready:** waits for running or ready containers, then latches. A later
  dependency failure does not retract its dependents.

Examples and props are in [API](api.md).

## Reconciliation and its limits

Each React controller render recomputes from the current desired and observed
state. The root publishes a runtime snapshot rather than replaying operations.
Container comparisons use the recorded spec digest and observed phase; an
empty plan skips `Runtime.apply`.

The containerd adapter takes a full snapshot when watching starts and when
the event stream ends or fails. It retries with resync while disconnected.
It does **not** periodically resync a healthy stream, so an unnoticed event
loss is not guaranteed to be repaired on a timer. The loop can only act on
changes the adapter has observed.

Networks are absent from `ObservedState`. `Plan.networks` compares the new
declaration with the last applied model, so it detects declaration edits,
not external network drift. The adapter delegates network handling to
Compose; detecting a subnet edit does not guarantee that an existing network
is replaced. An application with no services skips `compose up`, so a
network-only declaration does not create a network by itself.

## State and restart behavior

| State                                                   | Lifetime                                    |
| ------------------------------------------------------- | ------------------------------------------- |
| React tree and Ready latches                            | Until unmount or process exit.              |
| Restart counters, rollout templates, last applied model | In memory for one control loop.             |
| Containers and their labels                             | In the runtime; read again after restart.   |
| Observed store                                          | An in-memory view rebuilt from the runtime. |

Labels record spec digest, ownership, generation, and readiness configuration.
They do not store old rollout templates. Restarting fiber-servo resets backoff
and rollout history. It converges to the current tree, but **does not resume
an interrupted rollout**: old generations without retained templates are
removed without gradual draining.

`stop()` removes the application. `detach()` stops reconciliation and leaves
runtime resources in place. See [lifecycle API](api.md#serveelement-options).

## Code map

Paths below are relative to `src/`.

| File                                            | Responsibility                                          |
| ----------------------------------------------- | ------------------------------------------------------- |
| `resources.ts`, `components.tsx`                | Specs and JSX components.                               |
| `hostConfig.ts`, `reconciler.ts`                | React renderer and desired snapshots.                   |
| `hooks.ts`, `observed.ts`                       | Observed store and subscriptions.                       |
| `controllers.ts`, `generations.ts`              | Resource expansion and retained templates.              |
| `compose.ts`, `planner.ts`                      | Compose model and informational change plan.            |
| `serve.ts`                                      | Reconciliation and restart backoff.                     |
| `runtime/types.ts`, `runtime/memory.ts`         | Adapter contract and in-memory implementation.          |
| `runtime/containerd/`                           | Compose execution, gRPC observations, readiness probes. |
| `cli.ts`, `session.ts`, `control.ts`, `load.ts` | CLI, serialized apply, local endpoint, app loading.     |

For rationale see [Design decisions](decisions.md); for scope and open
questions see [Project scope](../PLAN.md).
