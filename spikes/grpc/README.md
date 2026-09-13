# Spike: containerd over gRPC

A runnable proof of the risky parts of talking to containerd directly,
instead of through nerdctl. The report it backs is
[`docs/grpc-design.md`](../../docs/grpc-design.md).

**It needs no containerd.** `src/fake-containerd.ts` starts a real gRPC
server, built from the same vendored protos, on a unix socket in a temp
directory. Nothing here needs root, a registry, an image, or a network.

Nothing under `src/` of the package depends on this directory, and the spike
is not part of the published package (`package.json` `files` is `dist`).

## Running it

```sh
npm test                # the spike's tests run with the rest of the suite
npx vitest run spikes/grpc/test/grpc.test.ts   # just this
npm run spike:grpc      # the same flow, narrated
```

`npm test` collects it because `vitest.config.ts` includes
`spikes/*/test/**/*.test.{ts,tsx}` next to `test/**`. `npm run typecheck`
covers it because `tsconfig.json` includes `spikes`. Neither `npm run build`
nor the published package includes it.

`npm run spike:grpc` prints the RPC sequence, which is the short version of
the whole report:

```
Images/Get  Snapshots/Prepare  Containers/Create      <- create
Tasks/Get   Snapshots/Mounts   Tasks/Create  Tasks/Start   <- start
Containers/List  Tasks/List                            <- list, for prune and the initial sync
Tasks/Exec  Tasks/Start  Tasks/Wait  Tasks/DeleteProcess   <- readiness probe
Tasks/Get   Tasks/Delete  Containers/Delete  Snapshots/Remove   <- remove
```

## What is in here

| Path                     | What it is                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `protos/`                | 14 `.proto` files copied from containerd's API module, Apache-2.0. Provenance and the file list: [`protos/NOTICE.md`](protos/NOTICE.md) |
| `src/protos.ts`          | loads them with `@grpc/proto-loader`; `keepCase` on, one include dir                                                                    |
| `src/client.ts`          | the unix-socket target and the `containerd-namespace` metadata header; unary and server-streaming calls as promises and async iterables |
| `src/any.ts`             | `google.protobuf.Any` the containerd way: bare protobuf full names, and JSON for typeurl-registered types like the OCI spec             |
| `src/oci.ts`             | the minimum viable `config.json`, with containerd's own defaults transcribed from its Go `oci` package                                  |
| `src/driver.ts`          | the `ContainerDriver` interface proposed in the report, and a gRPC implementation of the part that can be proved                        |
| `src/events.ts`          | containerd's event envelope translated into the row `interpretEvent` in `src/runtime/containerd/events.ts` already consumes             |
| `src/fake-containerd.ts` | the fake server                                                                                                                         |
| `src/run.ts`             | `npm run spike:grpc`                                                                                                                    |
| `test/grpc.test.ts`      | the assertions                                                                                                                          |

## What the spike proves

- The vendored protos load with `@grpc/proto-loader` and need no external
  include path.
- `unix:///run/containerd/containerd.sock` is the target string, and
  `containerd-namespace` is the metadata header. A call without it is
  refused, which is what containerd does.
- The OCI runtime spec goes into `Container.spec` as **JSON** under the type
  URL `types.containerd.io/opencontainers/runtime-spec/1/Spec`, not as a
  protobuf message. A hand-built spec with containerd's defaults round-trips.
- `Tasks.Create` needs rootfs mounts, and they come from the snapshotter, so
  a container's snapshot has to be prepared before the container record and
  removed after it.
- `Events.Subscribe` yields envelopes whose `Any` unpacks into exactly the
  body `interpretEvent` already reads, so the existing translation does not
  change for a gRPC driver.
- Two real bugs a naive port would have shipped:
  - a `/tasks/exit` with `id: ''` (the protobuf default, and what the proto
    documents as "the init exec") is dropped by `interpretEvent`, so every
    death would be invisible;
  - `/containers/delete` carries `id`, not `container_id`, so the row is
    anonymous and the store never forgets the container.
- `Containers.List` with `labels."fiber-servo.managed"=="true"` is evaluated
  server-side: that is what `prune()` and the watcher's initial sync need.
- A readiness probe is `Tasks.Exec` + `Tasks.Start` + `Tasks.Wait`, with
  empty stdio, and yields an exit code.

## What the spike does NOT prove

- **Anything below containerd's API.** No runc, no overlayfs, no process ever
  runs. That the OCI spec in `src/oci.ts` is _accepted by runc_ is untested;
  it is a transcription of containerd's defaults, not a verified spec.
- **Image pull.** `Images.Get` is a lookup, not a pull. The transfer service
  is not vendored and not exercised.
- **The chain id.** The driver takes the rootfs parent from a label the fake
  puts on the image record. On a real containerd it has to be read from the
  image's config blob in the content store.
- **CNI networking, name resolution and published ports.** containerd has no
  API for any of them.
- **Exec stdio.** Only the exit code is proved. Capturing output needs FIFOs
  the client creates itself.
- **Timing and failure modes of a real daemon**: a restarted containerd, a
  dropped stream, a slow shim, ttrpc.
