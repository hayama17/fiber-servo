# API reference

Everything is exported from the package root.

```ts
import { createRoot, Container, Deployment, Network, Ready } from 'fiber-servo';
```

## Root

### `createRoot(options?): Root`

| Option            | Type              | Default                 | Meaning                              |
| ----------------- | ----------------- | ----------------------- | ------------------------------------ |
| `sink`            | `OpSink`          | no-op                   | Receives one batch of ops per commit |
| `status`          | `StatusStore`     | fresh store             | Store the tree reads from            |
| `onUncaughtError` | `(error) => void` | rethrow from `render()` | Replace the default error handling   |

`Root`:

- `render(element)`: set the desired state and flush synchronously. Every op
  the commit produced has reached the sink when it returns. Render errors are
  thrown from here.
- `flush()`: commit work scheduled outside `render()` (store events, self-heal
  timers) right now.
- `settle(): Promise<void>`: resolve once nothing is left to commit, including
  Suspense retries that go through React's Scheduler.
- `unmount()`: tear the tree down; emits `DELETE` for everything live.
- `liveIds(kind = 'container')`: ids with an outstanding `CREATE`, in creation
  order.
- `status`: the store this root reads.

### `collectOps()`

A sink for tests and dry runs: `{ ops, batches, sink, take() }`.

### `serve(element, options): Served`

The one-call entry point. Creates the store, binds the runtime, starts its
watcher, renders.

| Option    | Type              | Meaning                                                        |
| --------- | ----------------- | -------------------------------------------------------------- |
| `runtime` | `Runtime`         | `containerd(options)` or `dummy(options)`, or your own         |
| `status`  | `StatusStore`     | Default: a fresh store                                         |
| `log`     | `(line) => void`  | Runtime logging                                                |
| `onError` | `(error) => void` | Runtime errors. Default: `console.error`                       |
| `onOps`   | `(ops) => void`   | Observe each batch before the runtime gets it                  |
| `prune`   | `boolean`         | Delete managed resources the tree does not declare. Default on |

`Served` has `root`, `status`, and `stop()`: unmount (every `DELETE`), wait
for the runtime to drain, stop the watcher.

A `Runtime` is
`(ctx: { status, log, onError }) => { sink, idle?, watch?, synced?, prune? }`.

| Handle member   | Meaning                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `sink`          | One batch per commit                                                         |
| `idle()`        | Resolves once every batch received so far has run                            |
| `watch(signal)` | Feeds the status store until `signal` aborts                                 |
| `synced`        | Resolves once `watch()` has reflected what already exists into the store     |
| `prune(keep)`   | Remove managed resources absent from `keep`; resolves with the names removed |

`keep` is `PruneKeep`: `{ containers: readonly string[]; networks: readonly string[] }`.
When both `prune` and `prune !== false` are present, `serve()` waits for
`synced`, then `root.settle()`, then calls `prune()` once with the tree's
`liveIds`. Waiting for both is required, not incidental: see
[decision 20](decisions.md#20-orphans-are-reaped-once-after-the-first-sync-and-the-first-settle).

## Components

### `<Container>`

| Prop        | Type                                   | Notes                                                            |
| ----------- | -------------------------------------- | ---------------------------------------------------------------- |
| `name`      | `string`                               | Identity. Required unless a parent assigns it (`<Deployment>`)   |
| `image`     | `string`                               | Required                                                         |
| `command`   | `string[]`                             |                                                                  |
| `env`       | `Record<string, string>`               |                                                                  |
| `ports`     | `number[]`                             | Container-side ports, as documentation; not published            |
| `publish`   | `PortMapping[]`                        | Host ports to bind: `{ host, container, protocol? }`             |
| `labels`    | `Record<string, string>`               |                                                                  |
| `network`   | `string`                               | Overrides the enclosing `<Network>`                              |
| `readiness` | `{ exec: string[]; intervalMs? }`      | Probe run inside the container; dependents wait for it           |
| `restart`   | `'always' \| 'never' \| RestartPolicy` | Default `'always'`                                               |
| `children`  |                                        | Dependents: mount once this is running (or ready), unmount first |

`RestartPolicy`:

| Field          | Default   | Meaning                                      |
| -------------- | --------- | -------------------------------------------- |
| `baseDelayMs`  | 1000      | Delay before the first restart               |
| `factor`       | 2         | Multiplier per consecutive restart           |
| `maxDelayMs`   | 300000    | Cap on the delay                             |
| `maxRestarts`  | unlimited | Give up after this many consecutive restarts |
| `resetAfterMs` | 600000    | Running this long resets the counter         |

### `<Deployment name replicas>`

Stamps each `<Container>` child out `replicas` times with keys and names
`${name}-${i}` (or `${name}-${childName}-${i}` for named templates). Keys are
the replica index, so scaling touches only the replicas that change.

`service={{ port, targetPort?, publish?, name?, target? }}` also renders a
`<Service>` in front of the replicas, named after the deployment unless
`name` says otherwise. With named templates, `target` picks which one to
balance across.

### `<Service name port targets>`

A caddy reverse proxy (`DEFAULT_PROXY_IMAGE`, override with `image`) that
round-robins across `targets` on `targetPort` (default `port`) and, with
`publish`, binds that host port. Renders nothing when `targets` is empty.
Scaling the targets is an `UPDATE` of the proxy's command.

### `<Network name subnet? labels?>`

Second host element. Containers inside attach to it and, on containerd,
resolve each other by name. Created before its containers, deleted after
them. Fields other than `name` are immutable; changing one emits an
`UPDATE` the containerd runtime refuses.

### `<Ready on>`

`on` is a container name or a list. Children do not mount until every listed
container has satisfied `until` once: `'running'` (default) or `'ready'`
(its readiness probe passed). Sugar for a `<Suspense fallback={null}>`
boundary around a component calling `useReady`. Nesting children inside a
`<Container>` does the same for that one dependency, with `until` chosen
from whether it has a probe.

## Hooks

- `useContainerStatus(id): ContainerStatus`: the `useSyncExternalStore` read.
- `useSelfHeal(id, mode?): number`: the restart generation for `id`; what
  `<Container>` renders as the `restarts` host prop.
- `useReady(ids, until?)`: suspend until every id satisfies `until`
  (`'running'` by default, or `'ready'`) once; latched.
- `isReady(status, until)`: the predicate behind it.
- `useStatusStore()`, `useNetwork()`: the context values.
- `readyThenable(store, id, until?)`: the cached thenable `useReady` uses.
- `backoffDelay(n, policy)`, `DEFAULT_RESTART_POLICY`.

## Status store

### `createStatusStore(now?): StatusStore`

| Method                    | Meaning                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `get(id)`                 | Snapshot, or the shared `UNKNOWN_STATUS`                                              |
| `set(id, state, detail?)` | Record one event; `seq` advances even if the state repeats                            |
| `mark(id, detail)`        | Amend the snapshot (e.g. `ready: true`) without changing state; no-op for unknown ids |
| `remove(id)`              | Forget the id                                                                         |
| `subscribe(listener)`     | Returns an unsubscribe function                                                       |
| `entries()`               | Every recorded id                                                                     |

`ContainerStatus`: `{ state: 'unknown' | 'running' | 'dead', seq, at, exitCode?, reason?, ready? }`.
Snapshots are frozen and stable between events.

## Ops

```ts
type Op =
  | { type: 'CREATE'; kind: 'container'; id; spec: ContainerSpec }
  | { type: 'CREATE'; kind: 'network'; id; spec: NetworkSpec }
  | { type: 'UPDATE'; kind; id; prev; next; changed: (keyof Spec)[] }
  | { type: 'DELETE'; kind; id }
  | { type: 'START'; kind: 'container'; id; attempt: number };
```

`OpSink = (ops: readonly Op[]) => void`. Helpers: `formatOp(op)`,
`diffSpec(kind, prev, next)`, `normalizeBatch(ops)`.

`DELETE` ops carry the last spec (`spec`) when the reconciler knows it. Each
commit's batch is already reduced to its net effect per `kind:name`: a
subtree remount that lands on the same names arrives as `UPDATE`s or
nothing, never as `DELETE` + `CREATE`.

## Runtimes

### `dummy({ log? })` / `createDummyRuntime(options?)`

Prints ops. With a store it also reports `CREATE` / `START` as `running`
(and `ready` for containers with a probe) and forgets on `DELETE`, which
closes every loop without a runtime. `dummy()` is the `Runtime` form for
`serve()`.

### `containerd({ namespace?, address?, bin?, probeTickMs? })`

The `Runtime` form: executor, event watcher and readiness prober wired to
one nerdctl. The pieces are also exported:

- `createNerdctl({ bin?, namespace?, address? }): Nerdctl`
- `createContainerdRuntime({ nerdctl, status?, index?, log?, onError?, probeTickMs? })`
  returns `{ sink, idle(), probe(signal), prune(keep) }`.
- `prune({ containers, networks })` lists managed resources
  (`ps -a --filter label=fiber-servo.managed=true`, `network ls`), removes
  every one not listed (`rm -f`, then `network rm`), forgets their status, and
  resolves with the names removed. It runs on the executor's queue, so it
  never interleaves with a batch.
- `watchContainerd({ nerdctl, status, index?, signal?, reconnectDelayMs?, log?, onError?, onSynced? }): Promise<void>`
  — `onSynced` fires after every successful `ps -a`, which is how
  `containerd()` builds the handle's `synced`.
- `syncFromPs`, `interpretEvent`, `parsePsLine`, `parsePsStatus`, `runArgs`,
  `networkCreateArgs`, `specDigest`, `MANAGED_LABEL`, `SPEC_LABEL`.

See [containerd.md](containerd.md) for how the runtime behaves.

## CLI

```
fiber-servo plan <app.tsx>                       print the ops, execute nothing
fiber-servo up   <app.tsx> [--watch] [--runtime containerd|dummy]
                           [--namespace n] [--address sock] [--quiet]
                           [--no-prune]
```

`app.tsx` default-exports a React element or a component. `plan` runs the
tree against `dummy()` and prints every commit, gated subtrees included.
`up` runs it against `containerd()` (or `dummy()` with `--runtime dummy`),
prints ops and status changes, and tears everything down on Ctrl-C.
`--watch` re-imports the file whenever it is saved and renders the result;
React diffs it against the running tree, so only what changed produces ops.
Only the entry file is watched; modules it imports stay cached. TypeScript
files are loaded through `tsx`.

`up` also reaps once at startup: managed containers and networks the file no
longer declares are deleted after the runtime has synced and the tree has
settled. `--no-prune` leaves them alone.
