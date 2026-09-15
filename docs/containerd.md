# Running on containerd

The adapter applies Compose models through nerdctl and observes containers
through containerd gRPC. See [Architecture](architecture.md) for the control
loop and its recovery limits.

## Requirements

- Node 20+.
- containerd and `nerdctl` on the host.
- Permission to access the containerd socket, using root or rootless setup.

The repository's recorded live verification used containerd 2.2.2 and
nerdctl 2.1.2. The behavior below is based on those versions.

## Configuration

```tsx
import { containerd, serve } from 'fiber-servo';

const served = serve(<App />, {
  project: 'my-app',
  runtime: containerd({ namespace: 'default' }),
});
```

| Option             | Default                                         | Purpose                                                      |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------ |
| `namespace`        | `default`                                       | Shared by nerdctl and containerd gRPC.                       |
| `address`          | `/run/containerd/containerd.sock`               | Socket for both paths; configure for rootless setups.        |
| `bin`              | `nerdctl`                                       | Actuator executable.                                         |
| `project`          | From `serve()`                                  | Override only when driving the adapter directly.             |
| `composeFile`      | `join(tmpdir(), 'fiber-servo', 'compose.json')` | Stable file used by both apply and down.                     |
| `probeTickMs`      | `250`                                           | Readiness scheduling interval.                               |
| `reconnectDelayMs` | `1000`                                          | Delay between event-stream retries and disconnected resyncs. |

Set the project through `serve({ project })`. The adapter rejects a model
whose project differs from the project it observes. Use one writer per
namespace/project, and separate `composeFile` paths for separate applications;
the default path is shared.

## Apply and teardown

`apply(model)` receives the complete desired application:

1. Read recorded spec digests from project containers.
2. Write the model with temporary entries for orphaned services.
3. Run `compose -f <file> rm -f -s <changed…> <orphaned…>` if needed.
4. Rewrite the exact desired model, removing temporary entries.
5. Run `compose -f <file> up -d --no-recreate` if the model has services.

In the recorded nerdctl verification, plain `up -d` recreated unchanged
containers. `--no-recreate` preserves them and starts stopped containers;
explicit removal makes a spec change take effect. Orphan entries are needed
because `compose rm` requires its targets in the file.

An empty service map skips `up`, which otherwise fails with
`no service was provided`. Network-only declarations therefore do not create
networks by themselves. Network edits are delegated to Compose; the adapter
does not explicitly recreate networks.

`down()` restores the last model that declared resources, then runs
`compose -f <file> down`. This retains network declarations after the final
empty apply. If no model was applied in this process it uses the existing
file; a missing file makes down a no-op.

## Runtime metadata

| Label                        | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `fiber-servo.managed`        | Management marker used by the planner.             |
| `fiber-servo.spec`           | SHA-256 digest of the creation spec.               |
| `fiber-servo.readiness`      | Percent-encoded probe configuration, when present. |
| `fiber-servo.owner`          | Owning Deployment or ReplicaSet.                   |
| `fiber-servo.generation`     | Full template digest.                              |
| `com.docker.compose.service` | Controller-selected service name.                  |
| `com.docker.compose.project` | Compose project used to scope observations.        |
| `nerdctl/networks`           | Container network membership.                      |

The adapter reads spec digests and probes from labels after restart. Rollout
templates remain in memory and are lost with the control plane; see
[restart behavior](architecture.md#state-and-restart-behavior).

Containerd's recorded limit is 4096 bytes per label key/value pair. Readiness
configuration is variable-sized and subject to that limit; full templates
are never stored in labels.

The planner filters recorded digests by the managed marker. The containerd
adapter scopes reads by Compose project and derives removal candidates from
recorded digests; `down()` delegates project cleanup to Compose. Use a
dedicated project rather than treating the marker as an isolation boundary.

## Readiness

The tested nerdctl version ignores Compose healthchecks, so the adapter runs
`nerdctl compose exec <service> <probe…>`. Exit 0 latches readiness for the
current target; recreation resets it. This is startup readiness, not a
continuous health check.

Each attempt has `timeoutMs` (default 2000). The timeout kills the process
group so a child `nerdctl exec` cannot keep pipes or locks open and block
teardown. Set a longer timeout explicitly for slower probes.

Service selection checks running state and labels, not readiness. Use Ready
for declaration ordering; a Service is not a readiness filter.

## Observations

The adapter reads Containers and Tasks and subscribes to Events. Task
start/exit/delete events refresh container state; container deletion events
reconcile the known IDs against a fresh list. Task events use `container_id`;
container deletion events use `id`.

A full inspect runs when watching starts and after the stream ends or fails.
Retries use `reconnectDelayMs`, with a resync between attempts. There is no
periodic full resync while the stream is healthy. Network drift is not
observed.

## Other limitations

- No image refresh policy; Compose pulls missing images.
- Resource limits describe the requested spec, not measured cgroup limits.
- Service backend changes replace the proxy and may interrupt traffic.
- No Pod resource or sidecar orchestration.

## Code map

Paths are relative to `src/runtime/containerd/`.

| File         | Responsibility                                             |
| ------------ | ---------------------------------------------------------- |
| `index.ts`   | Runtime factory and shared configuration.                  |
| `nerdctl.ts` | Process execution and timeout handling; fakeable in tests. |
| `api.ts`     | gRPC client using vendored protobufs.                      |
| `parse.ts`   | Task phases and container-label decoding.                  |
| `runtime.ts` | Apply, down, observations, and readiness probes.           |
