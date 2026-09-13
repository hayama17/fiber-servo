# Running on containerd

fiber-servo talks to containerd through [nerdctl](https://github.com/containerd/nerdctl),
a CLI over containerd's gRPC API that also brings CNI networking. Two files
connect the reconciler to it, and neither is known to the reconciler:
`src/runtime/containerd/execute.ts` (ops in) and
`src/runtime/containerd/events.ts` (status out).

## Requirements

- containerd and nerdctl on the host; `nerdctl run hello-world` should work
  for the user that runs fiber-servo (root, or rootless nerdctl).
- Node 20+.

## Wiring

```tsx
import {
  createContainerdRuntime,
  createNerdctl,
  createRoot,
  createStatusStore,
  watchContainerd,
} from 'fiber-servo';

const nerdctl = createNerdctl({ namespace: 'default' }); // or { address: '/run/containerd/containerd.sock' }
const status = createStatusStore();
const index = new Map<string, string>(); // containerd id -> name, shared by both halves

const runtime = createContainerdRuntime({ nerdctl, status, index });
const root = createRoot({ status, sink: runtime.sink });

const stop = new AbortController();
void watchContainerd({ nerdctl, status, index, signal: stop.signal });

root.render(<App />);

// on shutdown:
root.unmount();
await runtime.idle();
stop.abort();
```

`serve(<App />, { runtime: containerd() })` does all of this in one call;
`examples/containerd.tsx` is that with logging, and `fiber-servo up` is the
same from the command line. The pieces above are for anything `serve()`
does not cover.

## What the executor does

Batches run strictly in order, one at a time.

| Op                 | nerdctl                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREATE container` | `inspect` first. Not found: `run -d`. Found with the same `fiber-servo.spec` digest label: adopt (`start` if stopped). Found with a different digest: `rm -f` then `run -d` |
| `UPDATE container` | `rm -f` then `run -d` with the new spec                                                                                                                                     |
| `START container`  | `start`; if the container has vanished, `run -d` from the last known spec                                                                                                   |
| `DELETE container` | `rm -f`, then forget its status                                                                                                                                             |
| `CREATE network`   | `network inspect`. Not found: `network create`. Found with our digest: adopt. Found without our label: use as is. Found with a different digest: error                      |
| `UPDATE network`   | Reported through `onError`; networks are immutable, rename instead                                                                                                          |
| `DELETE network`   | `network rm`                                                                                                                                                                |

`run` argv, for reference:

```
run -d --name <name> --restart=no --pull=missing \
  --label fiber-servo.managed=true --label fiber-servo.spec=<digest> \
  [--network <net>] [-p host:container[/udp]]... [-e K=V]... [--label k=v]... <image> [command...]
```

Restart policy is `no` on purpose: restarts are the tree's decision.

The executor writes to the status store only what it alone can observe: a
`run` or `start` that containerd refused becomes `dead` with the error message
as `reason`, so the tree retries with backoff. Lifecycle comes from the
watcher.

## What the watcher does

1. `ps -a --no-trunc --format '{{json .}}'` on start and after every
   reconnect. Rows carrying `fiber-servo.managed=true` are reflected into the
   store (`Up …` is `running`, `Exited (n) …` is `dead` with `exitCode: n`,
   `Created` is `dead`) and into the id index.
2. `events --format '{{json .}}'` as a stream. Per topic:
   - `/tasks/start`: `running`
   - `/tasks/exit` where the exiting process is the init process
     (`id == container_id`): `dead` with `exit_status`
   - `/containers/delete`: forget
   - everything else: ignored
3. Ids that are not in the index are resolved once with
   `inspect --format '{{.Name}} {{index .Config.Labels "fiber-servo.managed"}}'`
   and cached; containers without the label are ignored from then on.

If the stream ends (containerd restarted), the watcher waits
`reconnectDelayMs` and starts again from step 1.

## What the prober does

Containers whose spec has `readiness={{ exec, intervalMs? }}` are probed
while they are `running` and not yet `ready`:

```
nerdctl exec <name> <exec...>
```

Exit 0 marks the store `ready: true` for the snapshot the probe ran against;
a death in between wins. The next lifecycle event (a restart, say) clears the
mark, so a container that comes back is probed again. `probeTickMs` (default 250) is how often the prober looks for containers due; `intervalMs` (default 2000) is the spacing per container.

`serve()` with `containerd()` runs the watcher and the prober together;
with the pieces, call `runtime.probe(signal)` next to `watchContainerd`.

## What the pruner does

Everything above looks up resources the tree names. Nothing there can find a
container the tree has stopped naming: kill `up` without Ctrl-C, drop
`replicas` from 3 to 1, and `web-1` and `web-2` keep running forever
(issue #9). `runtime.prune({ containers, networks })` is the one place that
asks containerd what exists instead:

```
ps -a --no-trunc --filter label=fiber-servo.managed=true --format '{{json .}}'
network ls --format '{{json .}}'
network inspect --format '{{index .Labels "fiber-servo.managed"}}' <name>   # only if `network ls` printed no Labels
rm -f <name>                                                               # every managed container not in `containers`
network rm <name>                                                          # every managed network not in `networks`
```

It returns the names it removed and forgets their status. Four things about
that argv:

- The `ps` filter is an optimisation. The rows are parsed by the same
  `parsePsLine` the watcher uses, which checks the label again, so a nerdctl
  that ignored the filter still cannot make us delete a foreign container.
- `network ls` is unfiltered because `--filter label=` and the `Labels`
  column arrived late in nerdctl's life. A row without a `Labels` field is
  resolved with one `network inspect`; a row with an empty one is simply not
  ours. Neither path can conclude "managed" from silence.
- Containers are removed before networks: nerdctl refuses to remove a network
  that still has a container attached.
- It runs on the executor's queue, so it cannot interleave with a batch in
  flight; a `CREATE` committed just before it will have finished, and its
  container is in `keep`.

**When it is safe to run is the whole design.** `serve()` waits for
`handle.synced` (the watcher's first `ps -a`) and then `root.settle()` before
calling it, and never calls it again. The reasoning is decision 20: gated
subtrees are not declared until their dependency is reported running, the
first sync is what reports adopted containers running, and settle is what
lets the gates that opens declare their children. Pruning any earlier deletes
containers the tree is about to ask for. `serve(..., { prune: false })` and
`fiber-servo up --no-prune` turn it off.

## Assumptions about nerdctl's output

These were confirmed on a real host with nerdctl 2.x, but they are the first
place to look if something differs on yours:

- `events --format '{{json .}}'` prints objects with `ID`, `Topic`, and
  `Event` (the containerd event body as a JSON string). The parser also
  accepts `Event` as an object.
- `inspect --format` accepts Go templates over the docker-compatible
  inspect shape (`.Id`, `.State.Running`, `.Config.Labels`, `.Name`).
- `ps --format '{{json .}}'` rows have `ID`, `Names`, `Status`, `Labels`
  (comma-separated `k=v`).
- `network inspect --format '{{index .Labels "…"}}'` and
  `network create --label` work.
- `ps --filter label=k=v` narrows the listing. If a version does not, nothing
  breaks: the label check on each row is what decides.
- `network ls --format '{{json .}}'` rows have `Name`, and `Labels` on recent
  versions. A missing `Labels` costs one `network inspect` per network.

## Known limitations

- `ports` are documentation; only `publish` binds host ports. Publish on a
  `<Service>` rather than on replicas, which would collide.
- Readiness probes are exec-only. HTTP and TCP probes would need a network
  path from the host into the CNI network.
- Networks are immutable after creation.
- An `UPDATE` recreates the container, so its exit event arrives during the
  recreate. The tree arms a restart for it, which the following `/tasks/start`
  cancels. If the recreate takes longer than the backoff (a slow image pull),
  the tree may emit a `START` that finds the container already running; that
  is a harmless no-op.
- Containers created under a different label prefix (an older name of this
  project) are treated as foreign and recreated on the next `CREATE`. Prune
  does not see them either, so they have to go by hand.
- Pruning assumes one fiber-servo per namespace, which is what the rest of
  the design assumes too (decision 1). Two apps sharing a namespace would
  each prune the other's containers; give them separate `--namespace`s.
