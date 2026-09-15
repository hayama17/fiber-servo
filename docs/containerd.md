# Running on containerd

The containerd adapter is the only part of fiber-servo that knows what a
container runtime is. Everything above it speaks specs (see
[`docs/architecture.md`](architecture.md)); this is where a spec becomes a
process.

It talks to two different things, and the seam between them is **who owns the
resource**:

```text
writes  ──> nerdctl compose      up / rm / down. Owns images, networks, running
reads   ──> containerd gRPC      Containers, Tasks, Events. Owns what is alive
```

fiber-servo never assembles a `nerdctl run` command line, and it never mutates
containerd — no `Containers.Create`, no `Tasks.Start`, no image pull, no
snapshot. Decisions 30 and 33 in [`docs/decisions.md`](decisions.md) record why
the seam moved here from an earlier read-versus-write split.

## Requirements

- containerd on the host, and `nerdctl` on `PATH`.
- Permission to reach containerd's socket (root, or rootless nerdctl).
- Node 20+.

Tested against containerd v2.2.2 and nerdctl 2.1.2.

## Using it

```tsx
import { containerd, serve } from 'fiber-servo';

const served = serve(<App />, {
  runtime: containerd({ namespace: 'default' }),
});
```

`containerd(options)`:

| Option             | Default                            |                                                                        |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------- |
| `namespace`        | `default`                          | containerd namespace. Reaches **both** seams; see below.               |
| `address`          | `/run/containerd/containerd.sock`  | containerd's socket. Rootless containerd puts it elsewhere.            |
| `bin`              | `nerdctl`                          | The actuator binary.                                                   |
| `project`          | from `serve()`                     | Normally left unset; see below.                                        |
| `composeFile`      | `$TMPDIR/fiber-servo/compose.json` | Where the rendered model is written. Must be stable — `down` reads it. |
| `probeTickMs`      | `250`                              | How often the readiness prober looks for work.                         |
| `reconnectDelayMs` | `1000`                             | Backoff before reattaching a dead event stream.                        |

**Two names must not be set twice.** `namespace` is computed once and handed
to both seams. It becomes
`nerdctl --namespace <ns> compose …` and containerd's `containerd-namespace`
gRPC metadata. If the two ever disagreed, the write path would create
containers the read path could not see, and the loop would create them again
for ever. `index.ts` is the only place it is resolved.

The Compose **project** has the same hazard and is settled the same way:
`serve({ project })` owns it and passes it to the adapter through
`RuntimeContext`, so `containerd({ project })` is only for driving the adapter
directly. Should the two ever disagree anyway, `apply()` refuses the model and
says so — a read path filtering for a project nothing was created under would
otherwise report the whole application missing on every pass and recreate it
for ever, without a single error.

## What `apply()` does

The control plane hands the adapter a whole `ComposeApplication` — never a
sequence of operations. Turning that into a running machine is three steps,
and the reason it is not one is measured, not assumed:

```text
1. render the model to composeFile
2. nerdctl compose -f <file> rm -f -s <changed…> <orphaned…>
3. nerdctl compose -f <file> up -d --no-recreate
```

`compose up -d` on its own recreates **every** container on every invocation,
even when nothing changed — nerdctl does not implement the config-hash check
Docker Compose has. Under a level-triggered loop that would churn the whole
application for ever. `--no-recreate` makes `up` idempotent (ids stay stable)
and self-healing (a killed container is simply started again), but it also
means literally that: a changed service is left alone. So step 2 evicts what
changed, and step 3 creates it back, creates what is new, and restarts what
merely stopped. One command, three jobs, and nothing in the adapter has to
tell them apart.

**Which services changed** comes from comparing the desired digest against the
`fiber-servo.spec` label read back off the running container. That is the same
recorded-spec mechanism the pre-Compose adapter used (decision 26), now
carrying the write path too.

**A wrinkle, verified against a real daemon.** `compose rm -s <service>`
validates its target against the file passed with `-f`, and fails with
`no such service` if the key is missing — it does not fall back to finding the
container by label. An orphaned service is by definition no longer in the
model, so step 1 writes the model _plus a bare `{ image }` stub_ for each
orphan, and rewrites the file as the true model immediately afterwards, before
`up` ever reads it.

An **empty** application is a legitimate desired state — it is what the last
pass of `serve().stop()` asks for — but `compose up` on a file with no
services fails outright (`no service was provided`). Step 2 has already
removed everything by then, so step 3 is skipped.

`down()` is `compose -f <file> down`, guarded by the file existing — `down`
against a missing file is an error, not a no-op. Before running it, the
adapter rewrites the file with the last model that **declared** anything:
`compose down` removes only the networks the file it is given declares, and by
then the file has usually been reduced to the empty model by that final
`apply()`. Without this the application's network outlives it, which is what a
live run showed.

## Labels, and how a restart recovers

Every container carries:

| Label                        |                                                                    |
| ---------------------------- | ------------------------------------------------------------------ |
| `fiber-servo.managed`        | Ours. Anything without it is left strictly alone.                  |
| `fiber-servo.spec`           | `digest()` of the `ContainerSpec` it was created from.             |
| `fiber-servo.readiness`      | The readiness probe, percent-encoded JSON. Only when there is one. |
| `fiber-servo.owner`          | The Deployment or ReplicaSet that produced it.                     |
| `fiber-servo.generation`     | Which template generation it belongs to.                           |
| `com.docker.compose.service` | Compose's own — and it is the name our controllers chose.          |
| `com.docker.compose.project` | Compose's own.                                                     |
| `nerdctl/networks`           | nerdctl's own. Network membership, without reading a CNI file.     |

Identity needs no label of fiber-servo's invention: Compose mangles the
container name to `<project>-<service>-<index>` but records the service name,
which is the name the controllers chose (`api-0`, `web-43bfee23d1cb5f62-1`). Two of
the six labels above are ours; the rest were already there.

**Every label here is small and fixed-width, deliberately.** containerd
refuses any label whose key and value together exceed 4096 bytes — measured:
6015 bytes rejected, two labels of 3000 bytes each accepted, so the cap is per
pair rather than across the set. A Deployment's whole `ContainerTemplate` was
briefly carried in a label, which made a perfectly legal spec with a few
kilobytes of environment impossible to create at all. Template history lives
beside the application instead; see decision 37.

A container with no `fiber-servo.managed` label is adopted, never removed —
fiber-servo shares a machine, it does not own one. And because the digest and
the probe live on the resource rather than in the process, a fiber-servo
restart recovers both: what each container was created from, and what to probe
it with.

## Readiness

Compose has a `healthcheck` field. **nerdctl does not implement it** — `up`
accepts one and silently ignores it — so readiness cannot be delegated and
fiber-servo runs the probe itself, with `nerdctl compose exec <service>`.

The probe has to reach the adapter somehow, and `apply()` receives a
`ComposeApplication` and nothing else. So it rides in the service's labels
under `fiber-servo.readiness`, written by `toComposeService` in
`src/compose.ts` and read back by the adapter — off the model for a service
about to be applied, and off a running container when rebuilding the schedule
after a restart.

**Every probe is bounded** (`timeoutMs`, default 2000), and the timeout kills
the process _group_, not the child. Both halves of that were found by running
it rather than reading it:

- An unbounded probe is not merely slow. `nerdctl exec` into a wedged
  container never returns, and it holds the container's exec lock — so the
  `compose rm` that teardown issues blocks behind it and **Ctrl-C never
  completes**. Measured before the fix: still running after 31 seconds; after
  it: 3 seconds, container removed.
- Signalling only the direct child does nothing, because `nerdctl compose
exec` is itself a parent of `nerdctl exec`: the grandchild survives holding
  the stdout pipe, so Node's `close` event never fires and the timeout has no
  effect at all. The child is spawned `detached` and the timeout signals
  `-pid`.

## Files

| File         |                                                                                    |
| ------------ | ---------------------------------------------------------------------------------- |
| `index.ts`   | `containerd()`: builds the two seams and resolves the namespace.                   |
| `nerdctl.ts` | The write seam: `exec`. Tests inject a fake.                                       |
| `api.ts`     | The read seam: containerd gRPC over vendored protos.                               |
| `parse.ts`   | Pure decoding: task status → phase, labels → `ObservedContainer`.                  |
| `runtime.ts` | The `Runtime` implementation: `apply`, `down`, `inspect`, `subscribe`, the prober. |

`api.ts` is separately testable against a live daemon without creating a
single container, which is how the event decoding was verified.

## Events

`Events.Subscribe` delivers typed events; `runtime.ts` maps topics:

| Topic                |                                 |
| -------------------- | ------------------------------- |
| `/tasks/start`       | the container's process is up   |
| `/tasks/exit`        | it stopped, with an exit status |
| `/tasks/delete`      | its task is gone                |
| `/containers/delete` | the container itself is gone    |

Task events name the container `container_id`; container events name it `id` —
a difference that silently broke `/containers/delete` handling until it was
caught against a live daemon.

If the stream dies, the adapter emits a `resync` from a full `inspect()` and
reattaches with backoff, so a missed event costs a late reconcile rather than
a wrong one. It also resyncs when a subscriber first attaches, so nothing has
to have been watching from the start.

## Known limitations

- **Single writer.** One fiber-servo per machine per namespace, per project.
  Two would each hold their own idea of desired state and fight.
- **No image pulling policy.** Compose pulls what is missing; there is no
  periodic refresh.
- **Resource limits are what was asked for**, not what the cgroup reports.
  containerd's API exposes no cgroup limits.
- **No sidecars.** A container is the unit (decision 32). Several containers
  sharing a network namespace would be a Compose feature
  (`network_mode: service:<name>`), not a fiber-servo resource kind.
