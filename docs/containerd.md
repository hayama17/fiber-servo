# Running on containerd

The containerd adapter is the only part of fiber-servo that knows what a
container runtime is. Everything above it speaks specs (see
[`docs/architecture.md`](architecture.md)); this is where a spec becomes a
process.

It talks to containerd two different ways, on purpose.

```text
writes  ──> nerdctl CLI            run, rm, update, network create/rm
reads   ──> containerd gRPC API    containers, tasks, phases, exit codes, events
networks ─> CNI config files       because containerd has no idea what a network is
```

Writing needs what nerdctl brings: image resolution and unpacking, OCI spec
generation, CNI attachment, port publishing. Reading needs none of it, and
paid for the CLI three times over — parsing `--format` output, a process spawn
per read, and a line-oriented parse of `nerdctl events`. Decision 29 in
[`docs/decisions.md`](decisions.md) records the split and the bug that forced
it.

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

| Option             | Default                           |                                                                                  |
| ------------------ | --------------------------------- | -------------------------------------------------------------------------------- |
| `namespace`        | `default`                         | containerd namespace. Also the CNI config subdirectory.                          |
| `address`          | `/run/containerd/containerd.sock` | containerd's socket.                                                             |
| `sandboxImage`     | `registry.k8s.io/pause:3.9`       | What a Pod's sandbox runs. Point it at a mirror if that registry is unreachable. |
| `cniPath`          | `/etc/cni/net.d`                  | Where networks are read from.                                                    |
| `probeTickMs`      | `250`                             | How often the readiness prober looks for work.                                   |
| `reconnectDelayMs` | `1000`                            | Backoff before reattaching a dead event stream.                                  |

## How a Pod is faked

containerd has no Pod. This adapter builds one the way CRI does:

```text
Pod "api"
├─ api            infra/sandbox container — owns the network namespace,
│                 runs `pause`, holds the published ports
├─ api-app        --network=container:api
└─ api-sidecar    --network=container:api
```

The infra container is named after the Pod, so `nerdctl ps` reads as one row
per Pod, and members are `<pod>-<container>`. `naming.ts` owns that mapping and
is the only place a runtime name is assembled.

**Published ports belong to the infra container.** Once a container joins a
namespace with `--network=container:X`, nerdctl refuses `-p` on it: the port
table belongs to X. So `PodTemplate.publish` is applied to the sandbox,
whichever member's process actually listens.

## Labels, and how a restart recovers

Every container carries:

| Label                   |                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fiber-servo.managed`   | Ours. Anything without it is left strictly alone.                                                                                                                                                      |
| `fiber-servo.pod`       | Which Pod it belongs to.                                                                                                                                                                               |
| `fiber-servo.container` | Which member it is.                                                                                                                                                                                    |
| `fiber-servo.role`      | `infra` or `member`.                                                                                                                                                                                   |
| `fiber-servo.spec`      | `digest()` of the spec it was created from.                                                                                                                                                            |
| `fiber-servo.spec-json` | The spec itself, percent-encoded JSON — `PodSpec` on the sandbox, `ContainerSpec` on a member. Percent-encoded because a raw JSON object does not survive `nerdctl ps`'s comma-joined `Labels` column. |

The last two are what make the immutability model work across a restart: the
planner compares a desired spec against the spec a Pod was _created_ with, not
against what is running, because only that tells it which field changed (see
decision 26). A container with no fiber-servo labels is adopted, never
removed — fiber-servo shares a machine, it does not own one.

## Files

| File         |                                                                    |
| ------------ | ------------------------------------------------------------------ |
| `index.ts`   | `containerd()`: wires the three seams together.                    |
| `nerdctl.ts` | The write seam: `exec`. Tests inject a fake.                       |
| `api.ts`     | The read seam: containerd gRPC over vendored protos.               |
| `cni.ts`     | Networks, read from `nerdctl-*.conflist`.                          |
| `naming.ts`  | Spec → argv, and Pod → runtime names. Pure.                        |
| `parse.ts`   | What little decoding is left: the spec label, task status → phase. |
| `runtime.ts` | The `Runtime` implementation itself.                               |

`api.ts` and `cni.ts` are separately testable against a live daemon without
creating a single container, which is how the network path and the event
decoding were verified.

## The one read still on nerdctl

A Pod's IP. It is a CNI result, not containerd state, and `ApiContainer`
carries nothing about networking, so it is still
`nerdctl inspect --format '{{.NetworkSettings.IPAddress}}'`. It is marked as
the exception in `runtime.ts`.

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
a wrong one.

## Known limitations

- **Resource values are what was asked for, not what the cgroup says.**
  `ObservedPod.spec` reports the recorded spec. containerd's API exposes no
  cgroup limits, and the previous nerdctl-based overlay read a field
  (`HostConfig.NanoCpus`) that nerdctl 2.1.2 does not emit, so it was already
  doing nothing.
- **Single writer.** One fiber-servo per machine per namespace. Two would each
  hold their own idea of desired state and fight.
- **No image pulling policy.** `--pull=missing`; there is no periodic refresh.
- **The sandbox image must be reachable.** `registry.k8s.io/pause:3.9` by
  default, which is blocked on some networks; use `sandboxImage`.
