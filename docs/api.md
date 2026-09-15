# API

Public exports are available from the package root. See [Architecture](architecture.md)
for responsibilities and [containerd](containerd.md) for adapter configuration.

```ts
import { Container, Network, ReplicaSet, Service, serve, containerd } from 'fiber-servo';
```

## Components

### `<Network>`

```tsx
<Network name="backend" subnet="10.88.0.0/24" />
```

A local bridge network, joined by Container's `network` prop. It has no
children. `subnet` maps to Compose's `ipam.config[].subnet`; Compose chooses
the gateway. No `labels` prop is exposed because the tested nerdctl version
ignores custom network labels. See [network limits](architecture.md#reconciliation-and-its-limits).

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
  publish={[{ host: 8080, target: 8080 }]}
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
| `readiness` | `ReadinessProbe?`        | `{ exec: string[]; intervalMs?: number; timeoutMs?: number }`. Exit 0 means ready.        |

Changing any Container field, including `resources`, replaces the container.

### `<ReplicaSet>`

```tsx
<ReplicaSet name="api" replicas={3}>
  <Container image="api:v1" labels={{ app: 'api' }} />
</ReplicaSet>
```

Keeps `replicas` copies of its Container template alive (default 1), named
`<name>-<index>`.

### `<Deployment>`

```tsx
<Deployment name="api" replicas={3} strategy={{ maxSurge: 1, maxUnavailable: 0 }}>
  <Container image="api:v2" labels={{ app: 'api' }} />
</Deployment>
```

Rolls out a Container template through ReplicaSets. Defaults: `replicas=1`,
`maxSurge=1`, `maxUnavailable=0`. Editing the template creates a new generation;
its full digest is the identity and a 16-character prefix appears in names.
Rollout history is process-local: a restart removes old generations without
gradual draining.

### `<Service>`

```tsx
<Service name="api" network="backend" selector={{ app: 'api' }} port={80} targetPort={8080} publish={8080} />
```

Proxies to running containers matching `selector`, sorted by name.
`targetPort` defaults to `port`; `publish` exposes the proxy on a host port.
The proxy joins `network`, but selection does not filter network membership
or readiness: selected backends must be reachable from it. No matches means
no proxy; backend changes replace it and may interrupt traffic.

### `<Ready>`

```tsx
<Ready on="db" until="ready">
  …
</Ready>
```

`on` accepts a name or an array of names. Children are declared after every
named container satisfies `until`: `running` by default, or `ready`.
The gate latches; a later dependency failure does not retract children.

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
| `onApply`               | `(p: Plan) => void`         | What each pass is about to apply after React controller admission.                                          |
| `generations`           | `GenerationHistory?`        | In-flight rollout history. Process-local and volatile; supply one only to inspect it.                       |
| `log`, `onError`, `now` |                             |                                                                                                             |

Returns:

```ts
interface Served {
  root: Root;
  observed: ObservedStore;
  reconcile(): Promise<void>; // force one pass
  idle(): Promise<void>; // wait for queued work
  stop(): Promise<void>; // end the application: runtime.down() removes it
  detach(): Promise<void>; // end the control plane: the machine is untouched
}
```

`stop()` unmounts the tree, drains reconciliation, removes the application,
and closes the adapter. `detach()` stops accepting reconciliation, clears
retries, unsubscribes, drains in-flight work, and unmounts without calling
`runtime.down()` or `runtime.close()`.

Use `detach()` before handing control to another loop. Dropping a `Served`
reference alone leaves its subscriptions active.

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
Network declarations are not observed; container attachments are available
as `ObservedContainer.networks`.

## Controllers, the Compose model, and the planner

`ReplicaSet`, `Deployment`, `Service`, and restart admission are React
controller behavior: they subscribe to `ObservedStore` and render the runtime
resources that should exist. The pure expansion functions remain exported for
direct use and testing.

All pure functions, callable directly:

```ts
runControllers(desired, observed); // → { networks, containers }
expandDeployment(spec, observed, generations); // → ReplicaSetSpec[]
expandReplicaSet(spec, observed); // → ContainerSpec[]
serviceEndpoints(spec, observed); // → Endpoint[]
serviceProxyContainer(spec, endpoints); // → ContainerSpec | undefined

toComposeApplication(containers, networks, project); // → ComposeApplication
renderCompose(app); // → the file handed to `nerdctl compose -f`

planApply({ networks, containers }, observed, project, previousModel); // → Plan
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
  networks: { added; removed; changed }; // against the last applied model, not observed state
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

`apply` takes the complete desired application and must be idempotent: an
unchanged running service keeps its identity. The control loop skips empty
plans, but adapters must tolerate repeated application.

Adapters read the creation spec digest (`SPEC_LABEL`) and probe configuration
(`READINESS_LABEL`) back from runtime metadata after restart. See
[metadata](containerd.md#runtime-metadata) for labels and limits.

`src/runtime/memory.ts` is the reference implementation and the shortest way to
see what the contract asks for.
