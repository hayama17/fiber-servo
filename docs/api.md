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

## Components

### `<Container>`

| Prop       | Type                                   | Notes                                                          |
| ---------- | -------------------------------------- | -------------------------------------------------------------- |
| `name`     | `string`                               | Identity. Required unless a parent assigns it (`<Deployment>`) |
| `image`    | `string`                               | Required                                                       |
| `command`  | `string[]`                             |                                                                |
| `env`      | `Record<string, string>`               |                                                                |
| `ports`    | `number[]`                             | Container-side metadata; not published yet                     |
| `labels`   | `Record<string, string>`               |                                                                |
| `network`  | `string`                               | Overrides the enclosing `<Network>`                            |
| `restart`  | `'always' \| 'never' \| RestartPolicy` | Default `'always'`                                             |
| `children` |                                        | Nested containers, if a runtime gives that meaning             |

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

### `<Network name subnet? labels?>`

Second host element. Containers inside attach to it and, on containerd,
resolve each other by name. Created before its containers, deleted after
them. Fields other than `name` are immutable; changing one emits an
`UPDATE` the containerd runtime refuses.

### `<Ready on>`

`on` is a container name or a list. Children do not mount until every listed
container has been reported `running` once. Sugar for a `<Suspense
fallback={null}>` boundary around a component calling `useReady`.

## Hooks

- `useContainerStatus(id): ContainerStatus`: the `useSyncExternalStore` read.
- `useSelfHeal(id, mode?): number`: the restart generation for `id`; what
  `<Container>` renders as the `restarts` host prop.
- `useReady(ids)`: suspend until every id has run once (latched).
- `useStatusStore()`, `useNetwork()`: the context values.
- `readyThenable(store, id)`: the cached thenable `useReady` uses.
- `backoffDelay(n, policy)`, `DEFAULT_RESTART_POLICY`.

## Status store

### `createStatusStore(now?): StatusStore`

| Method                    | Meaning                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `get(id)`                 | Snapshot, or the shared `UNKNOWN_STATUS`                   |
| `set(id, state, detail?)` | Record one event; `seq` advances even if the state repeats |
| `remove(id)`              | Forget the id                                              |
| `subscribe(listener)`     | Returns an unsubscribe function                            |
| `entries()`               | Every recorded id                                          |

`ContainerStatus`: `{ state: 'unknown' | 'running' | 'dead', seq, at, exitCode?, reason? }`.
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
`diffSpec(kind, prev, next)`.

## Runtimes

### `createDummyRuntime(options?)`

Prints ops. With `{ status }` it also reports `CREATE` / `START` as
`running` and forgets on `DELETE`, which closes the loop without a runtime.

### containerd

- `createNerdctl({ bin?, namespace?, address? }): Nerdctl`
- `createContainerdRuntime({ nerdctl, status?, index?, log?, onError? })`
  returns `{ sink, idle() }`.
- `watchContainerd({ nerdctl, status, index?, signal?, reconnectDelayMs?, log?, onError? }): Promise<void>`
- `syncFromPs`, `interpretEvent`, `parsePsLine`, `parsePsStatus`, `runArgs`,
  `networkCreateArgs`, `specDigest`, `MANAGED_LABEL`, `SPEC_LABEL`.

See [containerd.md](containerd.md) for how the runtime behaves.
