# API

Everything is exported from the package root. The layers below mirror
[`docs/architecture.md`](architecture.md); if a name here is unfamiliar, that
is the document that explains why it exists.

```ts
import { Pod, Container, ReplicaSet, Service, serve, containerd } from 'fiber-servo';
```

## Components

### `<Network>`

```tsx
<Network name="backend" subnet="10.88.0.0/24" labels={{ tier: 'app' }} />
```

A local bridge network. Pods join it by name. Every field but `name` is fixed
once created, so changing one replaces the Network.

Networks have no children — a Network does not own the Pods on it.

### `<Pod>`

```tsx
<Pod name="api" network="backend" labels={{ app: 'api' }} publish={[{ host: 8080, target: 80 }]}>
  <Container name="app" image="api:v1" />
  <Container name="sidecar" image="proxy:v1" />
</Pod>
```

| Prop      |                          |                                                                                                                                          |
| --------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `name`    | `string?`                | Identity. Required at the top level; omitted inside a `<ReplicaSet>` or `<Deployment>`, which name their copies.                         |
| `network` | `string?`                | Network to attach the sandbox to.                                                                                                        |
| `labels`  | `Record<string,string>?` | What a `<Service>` selector matches.                                                                                                     |
| `publish` | `PortMapping[]?`         | Host ports. Belong to the sandbox, not to a container. Do not set these on a replicated Pod — several replicas cannot share a host port. |

Every Pod prop defines the sandbox and is therefore immutable: changing one
replaces the Pod.

### `<Container>`

```tsx
<Container
  name="app"
  image="api:v1"
  command={['./server']}
  env={{ PORT: '8080' }}
  ports={[8080]}
  resources={{ cpu: 0.5, memory: '512m' }}
  readiness={{ exec: ['curl', '-fs', 'localhost:8080/health'], intervalMs: 2000 }}
/>
```

Only valid inside a `<Pod>`. `resources` is the one field that can change
without replacing the container; everything else is immutable. `ports` is
documentation for Services — it publishes nothing.

### `<ReplicaSet>`

```tsx
<ReplicaSet name="api" replicas={3}>
  <Pod labels={{ app: 'api' }}>
    <Container name="app" image="api:v1" />
  </Pod>
</ReplicaSet>
```

Keeps `replicas` Pods of its template alive, named `api-0`, `api-1`, …. Takes
exactly one unnamed `<Pod>`.

It declares a count, not identities — which is why a Pod dying needs no change
here and produces no React render.

### `<Deployment>`

```tsx
<Deployment name="api" replicas={3} strategy={{ maxSurge: 1, maxUnavailable: 0 }}>
  <Pod labels={{ app: 'api' }}>
    <Container name="app" image="api:v2" />
  </Pod>
</Deployment>
```

A rollout policy over ReplicaSets. The template's digest is its generation, so
editing the template creates a new ReplicaSet and shifts replicas to it within
`strategy`'s bounds rather than mutating Pods in place.

### `<Service>`

```tsx
<Service name="api" network="backend" selector={{ app: 'api' }} port={80} targetPort={8080} publish={8080} />
```

One address in front of whichever Pods currently match `selector`. The backend
set comes from observed state, not from a prop. With nothing matching, no proxy
is created at all.

### `<Ready>`

```tsx
<Ready on="db" until="ready">
  <Pod name="migrate">…</Pod>
</Ready>
```

Declares nothing inside until every Pod in `on` is observed `running`, or
`ready` when `until="ready"`. Latches: a dependency that later dies does not
retract what depends on it.

## Running a tree

### `serve(element, options)`

```ts
const served = serve(<App />, {
  runtime: containerd(),
  restart: { baseDelayMs: 1000, maxRestarts: 10 },
  onActions: (actions) => actions.forEach((a) => console.log(formatAction(a))),
});
```

| Option                  |                                  |                                                                                                             |
| ----------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `runtime`               | `RuntimeFactory`                 | `containerd()` or `memory()`.                                                                               |
| `observed`              | `ObservedStore?`                 | Bring your own; one is created otherwise.                                                                   |
| `restart`               | `RestartPolicy?`                 | Crash backoff. `baseDelayMs` 1000, `factor` 2, `maxDelayMs` 300000, `maxRestarts` ∞, `resetAfterMs` 600000. |
| `onDesired`             | `(d: DesiredState) => void`      | Every snapshot React commits.                                                                               |
| `onActions`             | `(a: readonly Action[]) => void` | Every reconcile's actions.                                                                                  |
| `log`, `onError`, `now` |                                  |                                                                                                             |

Returns:

```ts
interface Served {
  root: Root;
  observed: ObservedStore;
  reconcile(): Promise<void>; // force one pass
  idle(): Promise<void>; // wait for queued work
  stop(): Promise<void>; // unmount, reconcile it away, stop watching
}
```

### `createRoot(options)`

React without the control loop, when you want the snapshots and nothing else.

```ts
const collected = collectSnapshots();
const root = createRoot({ onCommit: collected.onCommit });
root.render(<App />);
collected.last(); // DesiredState
```

`root.flush()` commits work scheduled outside `render()`; `root.settle()` also
waits for Suspense retries (what `<Ready>` uses).

## Reading observed state

```ts
const pod = served.observed.getPod('api-0');   // ObservedPod | undefined
served.observed.snapshot();                     // ObservedState, stable by identity
served.observed.subscribe(() => { … });
```

In components:

```tsx
const pod = usePod('db'); // ObservedPod | undefined
useReady('db', 'ready'); // suspend until up (needs a <Suspense>)
```

## Controllers and planner

Both are pure functions, callable directly:

```ts
runControllers(desired, observed); // → { networks, pods }
expandDeployment(spec, observed); // → ReplicaSetSpec[]
expandReplicaSet(spec, observed); // → PodSpec[]
serviceEndpoints(spec, observed); // → Endpoint[]

planAll({ networks, pods }, observed); // → Action[]
planPod(desiredPod, observedPod); // → Action[]
formatAction(action); // → "replace-pod api-0 because [image]"
```

## Runtimes

```ts
containerd({ namespace: 'default', address: '/run/containerd/containerd.sock' });
memory({ autoStart: true, autoReady: true });
```

`createMemoryRuntime()` additionally gives you a test handle:

```ts
const runtime = createMemoryRuntime();
runtime.calls; // readable trace of every call
runtime.kill('api-1'); // make a Pod die behind the control plane's back
runtime.markReady('db', 'postgres');
```

Writing your own adapter means implementing `Runtime` from
`src/runtime/types.ts`. `src/runtime/memory.ts` is the reference
implementation and the shortest way to see what the contract asks for.
