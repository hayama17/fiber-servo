# API

Everything is exported from the package root. The layers below mirror
[`docs/architecture.md`](architecture.md); if a name here is unfamiliar, that
is the document that explains why it exists.

```ts
import { Container, Network, ReplicaSet, Service, serve, containerd } from 'fiber-servo';
```

## Components

### `<Network>`

```tsx
<Network name="backend" subnet="10.88.0.0/24" labels={{ tier: 'app' }} />
```

A local bridge network. Containers join it by name. Networks have no children —
a Network does not own the containers on it.

Compose creates and removes networks as part of applying the model, so nothing
in fiber-servo decides anything about their lifecycle.

### `<Container>`

```tsx
<Container
  name="api"
  image="api:v1"
  command={['./server']}
  env={{ PORT: '8080' }}
  ports={[8080]}
  network="backend"
  labels={{ app: 'api' }}
  publish={[{ host: 8080, target: 80 }]}
  resources={{ cpu: 0.5, memory: '512m' }}
  readiness={{ exec: ['curl', '-fs', 'localhost:8080/health'], intervalMs: 2000 }}
/>
```

The unit of everything: one process, one image, one Compose service.

| Prop        |                          |                                                                                           |
| ----------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `name`      | `string?`                | Identity. Required at the top level; omitted as a `<ReplicaSet>`/`<Deployment>` template. |
| `image`     | `string`                 |                                                                                           |
| `command`   | `string[]?`              |                                                                                           |
| `env`       | `Record<string,string>?` |                                                                                           |
| `ports`     | `number[]?`              | Documentation for Services. Publishes nothing.                                            |
| `network`   | `string?`                | Network to join, by name.                                                                 |
| `labels`    | `Record<string,string>?` | What a `<Service>` selector matches.                                                      |
| `publish`   | `PortMapping[]?`         | Host ports. Do not set these on a replicated container — replicas would collide.          |
| `resources` | `ResourceLimits?`        | `{ cpu?: number; memory?: string }`.                                                      |
| `readiness` | `ReadinessProbe?`        | `{ exec: string[]; intervalMs?: number }`. Exit 0 means ready.                            |

**Every field is immutable, `resources` included.** Changing any of them
replaces the container. There is no in-place update: Compose has no
live-update primitive, so raising a memory limit restarts the process. See
decision 34.

### `<ReplicaSet>`

```tsx
<ReplicaSet name="api" replicas={3}>
  <Container image="api:v1" labels={{ app: 'api' }} />
</ReplicaSet>
```

Keeps `replicas` copies of its `<Container>` template alive, named
`<name>-<index>`. It declares a count, not identities — which is why a dead
container is a controller's problem and not a re-render.

### `<Deployment>`

```tsx
<Deployment name="api" replicas={3} strategy={{ maxSurge: 1, maxUnavailable: 0 }}>
  <Container image="api:v2" labels={{ app: 'api' }} />
</Deployment>
```

Rollout policy over ReplicaSets. Editing the template creates a new generation
(keyed by a digest of it) and shifts replicas across, rather than editing
containers in place.

### `<Service>`

```tsx
<Service name="api" network="backend" selector={{ app: 'api' }} port={80} targetPort={8080} publish={8080} />
```

A stable endpoint in front of whichever containers currently match `selector`.
The backend set is resolved from observed state, not from the tree.

### `<Ready>`

```tsx
<Ready on="db" until="ready">
  …
</Ready>
```

Nothing inside is declared until the named container(s) are observed
`running`, or `ready` when `until="ready"`. Latches: a dependency that later
dies does not retract what depends on it.

## Running a tree

### `serve(element, options)`

```ts
const served = serve(<App />, {
  runtime: containerd(),
  restart: { baseDelayMs: 1000, maxRestarts: 10 },
  onApply: (plan) => console.log(formatPlan(plan)),
});
```

| Option                  |                             |                                                                                                             |
| ----------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `runtime`               | `RuntimeFactory`            | `containerd()` or `memory()`.                                                                               |
| `observed`              | `ObservedStore?`            | Bring your own; one is created otherwise.                                                                   |
| `project`               | `string?`                   | The Compose project this tree applies as, passed down to the adapter. Default `fiber-servo`.                |
| `restart`               | `RestartPolicy?`            | Crash backoff. `baseDelayMs` 1000, `factor` 2, `maxDelayMs` 300000, `maxRestarts` ∞, `resetAfterMs` 600000. |
| `onDesired`             | `(d: DesiredState) => void` | Every snapshot React commits.                                                                               |
| `onApply`               | `(p: Plan) => void`         | What each pass is about to apply, after the restart gate has filtered it.                                   |
| `log`, `onError`, `now` |                             |                                                                                                             |

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
served.observed.get('api-0'); // ObservedContainer | undefined
served.observed.snapshot(); // ObservedState, stable by identity
served.observed.subscribe(() => { … });
```

In components:

```tsx
const container = useContainer('db'); // ObservedContainer | undefined
useReady('db', 'ready'); // suspend until ready (needs a <Suspense>)
```

`ObservedState` is `{ containers: ReadonlyMap<string, ObservedContainer>, revision }`.
There are no networks in it: Compose owns their lifecycle, so nothing in the
control plane decides anything about them. A container's own attachments are on
`ObservedContainer.networks`.

## Controllers, the Compose model, and the planner

All pure functions, callable directly:

```ts
runControllers(desired, observed); // → { networks, containers }
expandDeployment(spec, observed); // → ReplicaSetSpec[]
expandReplicaSet(spec, observed); // → ContainerSpec[]
serviceEndpoints(spec, observed); // → Endpoint[]
serviceProxyContainer(spec, endpoints); // → ContainerSpec | undefined

toComposeApplication(containers, networks, project); // → ComposeApplication
renderCompose(app); // → the file handed to `nerdctl compose -f`

planApply({ networks, containers }, observed, project); // → Plan
planIsEmpty(plan); // → nothing would change
formatPlan(plan); // → "create api-0 image=api:v1\nreplace db"
```

A `Plan` is informational — `Runtime.apply` is what actually changes anything:

```ts
interface Plan {
  model: ComposeApplication; // the whole desired application, never a diff
  missing: readonly string[]; // will be created
  changed: readonly string[]; // exist with a different spec digest; will be replaced
  restarting: readonly string[]; // same digest, but exited; will be restarted
  orphaned: readonly string[]; // managed, but no longer declared; will be removed
}
```

## Runtimes

```ts
containerd({ namespace: 'default', address: '/run/containerd/containerd.sock' });
memory({ autoStart: true, autoReady: true });
```

See [`docs/containerd.md`](containerd.md) for the containerd adapter's options
and behaviour.

`createMemoryRuntime()` additionally gives you a test handle:

```ts
const runtime = createMemoryRuntime();
runtime.calls; // readable trace of every call
runtime.kill('api-1'); // make a container die behind the control plane's back
runtime.markReady('db');
```

Writing your own adapter means implementing `Runtime` from
`src/runtime/types.ts`:

```ts
interface Runtime {
  apply(model: ComposeApplication): Promise<void>; // must be idempotent
  down(): Promise<void>;
  inspect(): Promise<ObservedState>;
  subscribe(listener: RuntimeEventListener): Unsubscribe;
  close?(): Promise<void>;
}
```

`apply` takes the complete desired application, not a list of operations:
deciding that a changed image means "remove this service, then recreate it" is
the adapter's business, because it is the only layer that knows its actuator
well enough to decide it. It must be a no-op when nothing changed — the control
loop is level-triggered and will call it again on every observation.

Two labels carry fiber-servo's own state on each container, and an adapter
reads both back rather than keeping them in memory, so that a fiber-servo
restart recovers:

```ts
SPEC_LABEL; // 'fiber-servo.spec' — digest() of the ContainerSpec it was created from
READINESS_LABEL; // 'fiber-servo.readiness' — the probe, via encodeReadiness/decodeReadiness
```

`src/runtime/memory.ts` is the reference implementation and the shortest way to
see what the contract asks for.
