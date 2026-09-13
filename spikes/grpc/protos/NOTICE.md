# Vendored containerd protos

These `.proto` files are copied verbatim, with no edits, from the containerd
API Go module:

|         |                                                                                                                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module  | `github.com/containerd/containerd/api`                                                                                                                                                                                            |
| Version | `v1.11.1` (the API module required by containerd `v2.3.5`)                                                                                                                                                                        |
| Source  | `https://proxy.golang.org/github.com/containerd/containerd/api/@v/v1.11.1.zip`, which the Go checksum database ties to `github.com/containerd/containerd` at tag `api/v1.11.1`, commit `f822a911ab2b7c73e30bc0f36ea319642c9711b1` |
| License | Apache-2.0, `LICENSE` in this directory, copied from the same module                                                                                                                                                              |

Apache-2.0 is permissive and compatible with this project's MIT license. The
obligations it creates for a redistributor are met here: the license text
travels with the files (`LICENSE`), the files are unmodified, and this note
states where they came from. Only the 14 files the driver needs are vendored,
not the module.

The `api` module carries its own version line: `v1.11.1` is a containerd **2.x**
API. There is no `v2` of this module.

## Files, and why each one is here

Roots (loaded by name in `../src/protos.ts`):

| File                                      | Bytes | Why                                                          |
| ----------------------------------------- | ----- | ------------------------------------------------------------ |
| `services/containers/v1/containers.proto` | 6315  | container records: Create, Get, List, Delete                 |
| `services/tasks/v1/tasks.proto`           | 5715  | the running process: Create, Start, Kill, Wait, Exec, Delete |
| `services/events/v1/events.proto`         | 2098  | `Subscribe`, the watcher's stream                            |
| `services/snapshots/v1/snapshots.proto`   | 4642  | the writable rootfs: Prepare, Mounts, Remove                 |
| `services/images/v1/images.proto`         | 4472  | resolving an image name to what is in the image store        |
| `services/version/v1/version.proto`       | 1009  | a cheap connectivity check at startup                        |
| `events/task.proto`                       | 2066  | the bodies of `/tasks/*` events                              |
| `events/container.proto`                  | 1180  | the bodies of `/containers/*` events                         |

Pulled in transitively by those (protoc `import`, resolved from this
directory as the single include dir):

| File                     | Bytes |
| ------------------------ | ----- |
| `types/mount.proto`      | 1728  |
| `types/descriptor.proto` | 1081  |
| `types/metrics.proto`    | 907   |
| `types/task/task.proto`  | 1349  |
| `types/event.proto`      | 1015  |
| `types/fieldpath.proto`  | 1767  |

14 files, 35344 bytes, plus the 10765-byte `LICENSE`.

`google/protobuf/{any,empty,timestamp,field_mask,descriptor}.proto` are also
imported; protobufjs (a dependency of `@grpc/proto-loader`) bundles all five,
so they are not vendored.

## Refreshing them

```sh
curl -sSO https://proxy.golang.org/github.com/containerd/containerd/api/@v/<version>.zip
unzip -q <version>.zip
# copy the files listed above out of github.com/containerd/containerd/api@<version>/
```

Check the import statements after an upgrade: from `v1.8.0` on they are
relative to the module root (`import "types/mount.proto"`), and in `v1.7.19`
and earlier they were fully qualified
(`import "github.com/containerd/containerd/api/types/mount.proto"`), which
changes where the files have to sit on disk.
