# containerd over gRPC: what it would take

A research note with a working spike behind it. Nothing in `src/` changed.
The runnable half is [`spikes/grpc/`](../spikes/grpc/README.md); everything
asserted here that says "proved" has a test there.

Decision 9 ("nerdctl, not gRPC") said direct gRPC needs OCI spec generation,
image unpacking and vendored protos, "none of which the project is about".
That is still true. This note makes it precise: which parts are cheap, which
are not, and where the seam belongs if the project ever wants both.

## The short version

- **The client stack is a solved problem.** `@grpc/grpc-js@1.14.4` plus
  `@grpc/proto-loader@0.8.1`, 14 vendored `.proto` files, 35 KB. Unix socket
  and namespace header are two lines each.
- **Lifecycle and events over gRPC are genuinely better than nerdctl.** No
  process spawn per op, no Go-template output parsing, server-side label
  filters, a real event stream, and the container id _is_ our name so the
  watcher's id-to-name index and its `inspect` fallback disappear.
- **Everything around them is worse, and two of them are not implementable
  at all.** Image pull is an RPC on containerd 2.x but a registry client on
  1.7. CNI networking and published ports are not containerd features in any
  version: nerdctl implements them itself. `<Network>` and
  `<Service publish>` would stop working.
- **The proposed seam is wrong.** The roadmap says "a direct containerd gRPC
  client behind the same `Nerdctl` interface". `exec(['run', '-d', ...])`
  cannot be implemented over gRPC: `run` is five RPCs, a pull, an OCI spec, a
  snapshot and a CNI call. The seam has to be one level up, at the operations
  the executor and the watcher actually perform.
- **Recommended scope: a hybrid, and not yet.** If this is built, build the
  gRPC driver for lifecycle + events + exec + list, and keep nerdctl for
  image pull and networking, behind one `ContainerDriver` interface that both
  implement. Land the interface first; it is worth having even if the gRPC
  driver is never written, because it is also what a podman or docker driver
  would need.

---

## 1. Client stack

### Packages

| Package              | Version  | Where           | Why                                                                                      |
| -------------------- | -------- | --------------- | ---------------------------------------------------------------------------------------- |
| `@grpc/grpc-js`      | `1.14.4` | devDependencies | Pure-JS gRPC. No native build, no `node-gyp`, works on Node 20+.                         |
| `@grpc/proto-loader` | `0.8.1`  | devDependencies | Parses `.proto` at runtime into a grpc-js service definition. Brings `protobufjs@7.6.6`. |

Both installed cleanly here with `npm install --save-exact`, and both are
exact-pinned on purpose: the wire format is the API, and a silent minor bump
in a protobuf runtime is the kind of thing that surfaces as a decoded field
missing rather than as an error.

They are **devDependencies** in this spike because nothing in `src/` imports
them. If the gRPC driver ships, they become `dependencies` (or better,
optional peer dependencies, so someone who only uses the nerdctl driver does
not carry them). The footprint is not small and should be stated plainly:

- 31 new entries in `package-lock.json` (`@grpc/grpc-js`, `@grpc/proto-loader`,
  `protobufjs` and its nine `@protobufjs/*` micro-packages, `long`,
  `@js-sdsl/ordered-map`, `lodash.camelcase`, and `yargs` with its eight
  dependencies, which proto-loader pulls in for a CLI nobody runs);
- about 8.5 MB on disk, of which grpc-js is 4.5 MB and protobufjs 3.2 MB.

Today the package has two runtime dependencies. This would be the largest
thing in it by an order of magnitude, for a runtime that is optional. That is
an argument for the driver seam (section 5) with a lazily imported driver
module, not an argument against gRPC.

### Alternatives considered

- **`nice-grpc` (2.1.17)** is a nicer API over `grpc-js` (promises and async
  iterables instead of callbacks and streams) but it expects generated code
  from `ts-proto`, which means a codegen step and generated TypeScript
  checked in. The promise/async-iterable wrapper this spike needs is 60 lines
  (`spikes/grpc/src/client.ts`); a build step is a permanent cost.
- **`ts-proto` / `protoc` codegen** gives real types for every message
  instead of `Record<string, unknown>`. Worth doing eventually, but it puts
  `protoc` (or `buf`) in the contributor toolchain and generated code in the
  tree. Runtime loading is the right choice for a spike and probably for the
  first shipped version.
- **`grpc` (the old `grpc-node` native package)** is deprecated. No.
- **Hand-rolled protobuf over a unix socket.** containerd's own Go clients
  use ttrpc for shims but plain gRPC/HTTP2 for the daemon. Writing an HTTP/2
  client is not a reasonable thing to do here.

### Connecting

containerd's default address is `/run/containerd/containerd.sock`
(`defaults/defaults_linux.go`). grpc-js understands the `unix:` scheme, so
the target is the address with `unix://` in front of it -- three slashes for
an absolute path:

```ts
const client = new Containers('unix:///run/containerd/containerd.sock', grpc.credentials.createInsecure());
```

`createInsecure()` is correct: the socket's file mode is the access control,
which is why this needs root or membership of the socket's group, exactly as
nerdctl does.

### The namespace

containerd has no ambient namespace. It reads one from gRPC metadata on
**every** call, and a call without it fails. The key is:

```
containerd-namespace
```

from `pkg/namespaces/grpc.go` (`GRPCHeader`). The ttrpc variant, used only
when talking to a shim directly, is `containerd-namespace-ttrpc`
(`pkg/namespaces/ttrpc.go`). `nerdctl --namespace` is nothing but this
header. `NerdctlOptions.namespace` maps onto it one-to-one.

Proved in `spikes/grpc/test/grpc.test.ts`: a `Containers.List` with empty
metadata comes back `INVALID_ARGUMENT: namespace is required`, and the same
call through the client works.

One asymmetry worth knowing: `Events.Subscribe` is the exception that ignores
the header for filtering. Its own proto says so -- "subscribers will get
messages from all namespaces unless otherwise specified" -- so the driver
must pass `filters: ['namespace==default']` or it will report containers
from every namespace on the host. Also proved.

---

## 2. Protos

### What was vendored, and from where

`github.com/containerd/containerd/api` at **`v1.11.1`**, which is the API
module that containerd **2.3.5** requires (`go.mod`:
`github.com/containerd/containerd/api v1.11.1`). Note the version line: the
API module is still on `v1.x` even for containerd 2.x; there is no `v2` of
it. Fetched from `proxy.golang.org`, which pins it to commit
`f822a911ab2b7c73e30bc0f36ea319642c9711b1`, tag `api/v1.11.1`.

**License: Apache-2.0.** Compatible with this project's MIT. The obligations
on a redistributor are met by keeping the license text next to the files
(`spikes/grpc/protos/LICENSE`), not modifying them, and stating their origin
(`spikes/grpc/protos/NOTICE.md`). Vendoring them into an MIT project is fine;
the MIT license of the project's own code is unaffected.

### The file list

8 roots, 6 more pulled in by `import`, 14 files, **35344 bytes** (plus the
10765-byte LICENSE). The full table with per-file sizes and reasons is in
[`spikes/grpc/protos/NOTICE.md`](../spikes/grpc/protos/NOTICE.md); the roots
are:

```
services/containers/v1/containers.proto   services/snapshots/v1/snapshots.proto
services/tasks/v1/tasks.proto             services/images/v1/images.proto
services/events/v1/events.proto           services/version/v1/version.proto
events/task.proto                         events/container.proto
```

and the transitive closure adds `types/{mount,descriptor,metrics,event,fieldpath}.proto`
and `types/task/task.proto`.

The only external imports are `google/protobuf/{any,empty,timestamp,field_mask,descriptor}.proto`,
all five of which protobufjs bundles. Nothing from `googleapis` is needed --
`google/rpc/status.proto` is imported only by
`services/introspection/v1/introspection.proto`, which this set does not
include.

Adding image pull through the transfer service would add 13 more files and
about 32 KB: `services/{content,leases,diff,transfer,streaming}/v1/*`,
`events/image.proto`, `types/platform.proto` and the six
`types/transfer/*.proto` (which the closure does **not** find, because
`transfer.proto` passes them as `google.protobuf.Any` -- easy to miss).
Total for the full set: 27 files, 67084 bytes.

### containerd 1.7 versus 2.x

The spike targets **2.x** (API `v1.11.1`). Three differences matter, and all
three are mechanical:

|                                | containerd 1.7 (api `v1.7.19`)                                                                | containerd 2.x (api `v1.8.0`+)                                |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Import paths inside the protos | `import "github.com/containerd/containerd/api/types/mount.proto";`                            | `import "types/mount.proto";`                                 |
| Where the include dir points   | a directory tree containing `github.com/containerd/containerd/api/...`                        | the module root                                               |
| The event envelope             | `containerd.services.events.v1.Envelope`, defined inline in `services/events/v1/events.proto` | `containerd.types.Envelope`, moved out to `types/event.proto` |

Everything the driver calls -- `Containers`, `Tasks`, `Snapshots`, `Images`,
`Events.Subscribe` -- has the same package, method names and message shapes
in both. `CreateTaskRequest` gained two fields in 2.x
(`task_api_address`, `task_api_version`, for in-VM shims), which is additive.
`types/runc/options/oci.proto` (the `containerd.runc.v1.Options` you would
pack into `Container.runtime.options` to set things like `NoPivotRoot`) is
new to the API module in 2.x; in 1.7 it lived in the main repo, outside the
api module.

Practical consequence: supporting both means vendoring one set and, for 1.7,
either re-pathing the imports or keeping a second copy. Supporting only 2.x
is the reasonable choice -- containerd 1.7 is in maintenance and nerdctl 2.x
already requires containerd 2.x features in places.

---

## 3. What `nerdctl run -d` actually hides

`nerdctl run -d --name web --network app -p 8080:80 -e K=V nginx:1.27` is one
process spawn. Over gRPC it is the following, in order. Every step is
something the client does; containerd does none of it on its own.

### 3.1 Resolve and pull the image

containerd's image store holds **references to content**, and nothing puts
content there by itself.

- **containerd 2.x**: `Transfer.Transfer(source, destination)` on
  `services/transfer/v1`. `source` is an `Any` of
  `containerd.types.transfer.OCIRegistry{reference, resolver}` and
  `destination` an `Any` of `containerd.types.transfer.ImageStore{name,
platforms, unpacks: [{platform, snapshotter}]}`. That single call resolves
  the reference, fetches the manifest and layers into the content store,
  creates the image record **and unpacks it into snapshots** -- everything in
  3.1 and 3.2 at once. This is the one place where 2.x is dramatically better
  than 1.7 for a non-Go client.
  - Registry auth is a callback on a **bidirectional stream**:
    `RegistryResolver.auth_stream` names a stream id, and the client answers
    `AuthRequest{host, reference, wwwauthenticate}` with
    `AuthResponse{authType, secret, username}` over
    `services/streaming/v1 Streaming.Stream` (a `stream Any` both ways, opened
    with a `StreamInit{id}`). Anonymous pulls from a public registry need none
    of this; anything with credentials needs all of it.
  - Progress is another stream (`TransferOptions.progress_stream`).
- **containerd 1.7**: the transfer service exists but is newer and less
  complete, and the path everyone actually used was client-side: resolve the
  reference over HTTP against the registry (`/v2/<name>/manifests/<ref>`
  with the OCI accept headers and Docker token auth), then for each blob
  `Content.Write` it in chunks into the content store, then `Images.Create`
  the record. That is a registry client: Docker token auth, `WWW-Authenticate`
  parsing, manifest lists and platform matching, chunked/resumable uploads,
  digest verification. Several hundred lines of exactly the code this project
  has no interest in owning.

**Recommendation: do not implement a registry client.** Either require
containerd 2.x and use the transfer service, or shell out to
`nerdctl pull` / `ctr images pull` for this one step. See section 6.

### 3.2 Unpack into a snapshot

If the pull did not unpack (1.7, or a transfer without `unpacks`), the client
must apply each layer: for every layer descriptor, `Snapshots.Prepare` a key
with the previous chain id as parent, `Diff.Apply` the layer over the
resulting mounts, then `Snapshots.Commit` under the new chain id. Chain ids
are `sha256(parent + " " + diffID)` folded over the layers -- OCI's
`identity.ChainID`.

There is a shortcut for the common case, and the spike uses it: after an
unpack, containerd writes the rootfs chain id as a label on the image's
**config blob** in the content store, named
`containerd.io/gc.ref.snapshot.<snapshotter>` (`core/unpack/unpacker.go`,
`client/image.go`). So "which snapshot is this image's rootfs" is a content
store lookup, not a computation -- but it still means reading the manifest
blob to find the config descriptor, which needs the content service.

### 3.3 Prepare the container's writable snapshot

```
Snapshots.Prepare{snapshotter: "overlayfs", key: "web", parent: "<chain id>"}
  -> mounts
```

This is the container's rootfs. It is **not** created by `Containers.Create`
and it is **not** removed by `Containers.Delete`; it is a separate object
with a separate lifetime, and forgetting to remove it is a disk leak that
nothing else will clean up. `Container.snapshotter` and
`Container.snapshot_key` on the container record only pin it against garbage
collection.

### 3.4 Build the OCI runtime spec by hand

`Container.spec` is an opaque `google.protobuf.Any`. containerd validates
**nothing** in it and supplies **no defaults**. Whatever is in there goes to
the shim and then to runc. A missing `process.args` is not an error from
containerd; it is a failure from runc, later, with a worse message.

Two things surprise a JS client:

1. **It is JSON, not protobuf.** containerd registers the Go
   `specs.Spec` type with `typeurl.Register(&specs.Spec{}, "types.containerd.io",
"opencontainers/runtime-spec", "1", "Spec")`, and `typeurl.MarshalAny`
   falls back to `json.Marshal` for non-protobuf types. So the field is
   `{type_url: "types.containerd.io/opencontainers/runtime-spec/1/Spec",
value: <JSON bytes>}`. Proved in the spike.
2. **Type URLs have no `type.googleapis.com/` prefix.** For real protobuf
   messages `typeurl` uses the bare full name (`containerd.events.TaskExit`).
   A client that follows the protobuf convention will not match.

What the Go `oci` package fills in that a JS client has to write itself
(transcribed into `spikes/grpc/src/oci.ts` from containerd 2.3.5
`pkg/oci/spec.go` and `pkg/oci/mounts.go`):

| Filled in by `oci.WithDefaultSpec`       | Detail                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ociVersion`, `root.path: "rootfs"`      | the shim's bundle layout                                                                                                             |
| `process.cwd`, `user`, `noNewPrivileges` | `/`, uid/gid 0, true                                                                                                                 |
| `process.capabilities`                   | the 14-capability default set, in all three of bounding/effective/permitted                                                          |
| `process.rlimits`                        | `RLIMIT_NOFILE` 1024/1024                                                                                                            |
| `mounts`                                 | the 7 default mounts: `/proc`, `/dev` (tmpfs), `/dev/pts`, `/dev/shm`, `/dev/mqueue`, `/sys`, `/run`, each with exact option strings |
| `linux.namespaces`                       | pid, ipc, uts, mount, network                                                                                                        |
| `linux.maskedPaths`                      | 11 paths under `/proc` and `/sys`                                                                                                    |
| `linux.readonlyPaths`                    | 5 paths under `/proc`                                                                                                                |
| `linux.cgroupsPath`                      | `/<namespace>/<id>`                                                                                                                  |
| `linux.resources.devices`                | the default deny-all rule                                                                                                            |

| Filled in by `oci.WithImageConfig` | Where it comes from                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `process.args`                     | image config `Entrypoint` + `Cmd`, overridden by the user's command                                                       |
| `process.env`                      | image config `Env`, merged with the user's, as `K=V` strings                                                              |
| `process.cwd`                      | image config `WorkingDir`                                                                                                 |
| `process.user`                     | image config `User`, resolved **against the rootfs** (`/etc/passwd` inside the image) when it is a name rather than a uid |

The image config is a blob in the content store. Reading it needs the content
service; `Images.Get` returns only a descriptor. And resolving a username to
a uid means mounting the snapshot and reading `/etc/passwd` from it -- which
containerd's Go client does and which a JS client would have to skip
(supporting numeric uids only) or reimplement.

Still not covered by any of the above, and left to the caller by containerd
too: seccomp (nerdctl and Docker ship a default profile of several hundred
syscalls; containerd's `oci` package has `WithDefaultSeccomp` but the profile
is Go code), apparmor, user namespaces, cgroup limits, devices, hostname and
`/etc/hosts` / `/etc/resolv.conf` (nerdctl writes these files itself and
bind-mounts them -- which is also where container name resolution comes
from, see 4.1), and the whole of Windows.

### 3.5 Create the container record

```
Containers.Create{container: {id, image, labels, runtime: {name: "io.containerd.runc.v2"},
                              spec: <Any>, snapshotter, snapshot_key}}
```

`id` is the identity, and this is a small gift: fiber-servo already keys
everything by name (decision 3), and containerd ids can be that name
directly. The whole `index: Map<containerd id, name>` that `execute.ts` and
`events.ts` share exists only because nerdctl invents its own 64-hex id and
keeps the name in a label.

Labels work the same as nerdctl's (`fiber-servo.managed`,
`fiber-servo.spec`), and `Containers.List` filters on them server-side with
containerd's filter syntax: `labels."fiber-servo.managed"=="true"`. That is
strictly better than `nerdctl ps --filter` plus parsing.

### 3.6 Create the task

```
Tasks.Create{container_id, rootfs: <mounts from 3.3>, stdin/stdout/stderr, terminal}
```

The mounts are required; the shim has nothing to mount without them. They
come from `Snapshots.Prepare` (first time) or `Snapshots.Mounts` (a restart),
which is why `START` on a stopped container is `Snapshots.Mounts` +
`Tasks.Create` + `Tasks.Start`, not a single call.

Stdio: paths to **FIFOs the client creates**, usually under
`/run/containerd/fifo/<ns>/<id>/`. containerd does not create them. Leaving
all three empty is legal and means `/dev/null`
(`cmd/containerd-shim-runc-v2/process/io.go`: `stdio.IsNull()`), which is
what a detached container wants anyway -- but it also means **container logs
are gone**. nerdctl solves this by running a `nerdctl` process as the shim's
logging driver and writing a JSON log file; a gRPC driver would have to
either accept no logs, write its own FIFO pump, or use the same
`binary://` logging URI mechanism.

### 3.7 Start it

```
Tasks.Start{container_id, exec_id: ""} -> pid
```

And that is the point at which `/tasks/start` shows up on the event stream.

### 3.8 What containerd does NOT do for you, in one list

- resolve a reference or pull an image (unless you use the transfer service);
- unpack layers into snapshots (same);
- create the container's snapshot, or delete it afterwards;
- supply any part of the OCI spec, including `process.args`;
- read the image config, or resolve a user name to a uid;
- create stdio FIFOs, or keep logs;
- any networking whatsoever: no CNI, no bridge, no port publishing, no DNS,
  no `/etc/hosts`;
- restart policies (fine -- they are the tree's job, decision 6);
- garbage-collect anything you did not label for collection;
- give you a name-to-id mapping (you choose the id, so it is moot).

---

## 4. The gaps that matter here, with recommendations

### 4.1 CNI networking and name resolution -- `<Network>` and `network="app"`

**containerd does not do CNI.** It has no network API at all. nerdctl
implements networking itself, and the shape of that implementation is the
argument (nerdctl 2.3.5, `pkg/netutil`, `pkg/ocihook`, `pkg/dnsutil/hostsstore`):

- `nerdctl network create` writes a CNI config file named
  `nerdctl-<name>.conflist` under the CNI netconf path (`/etc/cni/net.d`, or
  `$XDG_CONFIG_HOME/cni/net.d` rootless), with the `bridge`, `portmap`,
  `firewall` and `tuning` plugins, under its own lock file
  (`netutil/store.go`, `netutil/cni_plugin_unix.go`).
- `nerdctl run` does **not** do the CNI attach inline. It installs itself as
  an OCI `createRuntime` hook in the spec (`nerdctl internal oci-hook`,
  `pkg/cmd/container/create.go`), and a second nerdctl process, run by runc
  inside the container's lifecycle, does the CNI `ADD` from the spec's
  annotations; `postStop` does the `DEL` (`pkg/ocihook/ocihook.go`).
- Name resolution is not DNS. Each container gets a per-container hosts file
  from nerdctl's `hostsstore`, bind-mounted at `/etc/hosts`, and
  `updateAllHosts()` rewrites **every** container's hosts file whenever one
  joins or leaves (`pkg/dnsutil/hostsstore/hostsstore.go`). That is what makes
  `env={{ DATABASE_HOST: 'db' }}` resolve.

None of this is containerd. All of it is state nerdctl keeps in its own data
root, plus a helper process wired into the container's own lifecycle.

To do this over gRPC, fiber-servo would have to become a CNI runtime:

1. write CNI conflists for `<Network>`, and manage their lifetime;
2. create a network namespace per container and keep it pinned
   (`/run/netns/<id>`), before `Tasks.Create`, because the netns path has to
   be in the OCI spec's `linux.namespaces` entry for `network`;
3. shell out to (or reimplement the exec protocol of) the CNI plugin
   binaries: `ADD` on start, `DEL` on stop, `CHECK` on adoption, with the
   right `CNI_*` environment and stdin JSON;
4. maintain its own IPAM state and its own `/etc/hosts` rendering, and
   rewrite the file in every container that is already running whenever a new
   one joins -- nerdctl's `updateAllHosts()`, which is a small distributed
   system, not a feature;
5. clean up netns and IPAM leases when a container dies, including after a
   fiber-servo crash -- which nerdctl does from a `postStop` hook running
   inside the container's own teardown, an option a long-lived JS process
   does not have unless it installs a helper binary in the spec too.

Node has no CNI library. Go has `containernetworking/cni` and
`containerd/go-cni`, which is what nerdctl uses.

**Recommendation: do not.** This is several times the size of everything else
in this document, it is the part most likely to leak resources on a crash,
and it would be a reimplementation of nerdctl rather than of containerd. If a
gRPC driver is built, `<Network>` keeps using nerdctl, or the driver declares
`capabilities.networks: false` and the executor refuses a `CREATE network`
with a clear error.

### 4.2 Publishing host ports (`-p`)

Same answer, same reason. Port publishing is the CNI `portmap` plugin, which
nerdctl adds to the conflist it writes, plus iptables rules the plugin
installs. containerd has no notion of a published port. `<Service publish>`
(decision 16) depends on it.

**Recommendation: nerdctl, or nothing.** A gRPC driver without CNI has no
port publishing either, and should say so through `capabilities.publish:
false` rather than silently dropping `publish` from the spec.

### 4.3 `exec` for readiness probes

This one is straightforward and the spike covers it.

```
Tasks.Exec{container_id, exec_id, spec: Any(OCI Process, JSON), stdin/stdout/stderr, terminal}
Tasks.Start{container_id, exec_id}        // the exec does not run until this
Tasks.Wait{container_id, exec_id}         // blocks, returns exit_status
Tasks.DeleteProcess{container_id, exec_id}
```

Notes that matter:

- `spec` is an `Any` of the OCI **Process** (not Spec), JSON, type URL
  `types.containerd.io/opencontainers/runtime-spec/1/Process`. It needs at
  least `args` and `cwd`; it does not inherit the container's process
  settings automatically, so a probe that needs the container's `PATH` or
  user has to be given them.
- `exec_id` must be unique per exec and is what distinguishes the exec's
  `/tasks/exit` from the container's.
- **Empty stdio is fine** and gives `/dev/null`. Decision 15 only uses the
  exit code, so a readiness probe needs no FIFOs at all. If output were ever
  wanted, the client would have to create FIFOs and pump them.
- `Tasks.Wait` is a blocking unary call with no deadline of its own; a
  per-call deadline has to be set by the client, or a hung probe hangs a
  connection. The alternative is to not call `Wait` and instead watch the
  event stream for `/tasks/exit` with `id == exec_id`, which the watcher is
  already listening to -- arguably the better design, since it reuses the one
  stream.
- `DeleteProcess` matters: exec records are not reaped on their own.

**Recommendation: implement it.** It is the one gap that is strictly easier
over gRPC than through nerdctl (no process spawn per probe, and probes run
every 2 seconds per container).

### 4.4 Image pull: is the transfer service usable from JS?

**On containerd 2.x, yes, for the anonymous case, and it is a single RPC.**
`Transfer.Transfer` with `OCIRegistry` as source and `ImageStore` (with
`unpacks`) as destination does resolve, fetch, create and unpack
server-side. Everything the client sends is two `Any`s of messages from
`types/transfer/*.proto`, which are ordinary protobuf. That is perhaps 80
lines of JS and 13 more vendored protos.

Two caveats:

- **Authenticated pulls need a bidirectional stream.** Credentials are not a
  field; they are answered over `Streaming.Stream` when containerd calls back
  with an `AuthRequest`. Doable with grpc-js (duplex streams are supported),
  but it is the most complex piece of client code in the whole design, and it
  has to parse `WWW-Authenticate` to decide between token exchange and a
  plain header.
- **The transfer plugin must be enabled**, and registry hosts/mirrors come
  from containerd's own `hosts.d` configuration (`RegistryResolver.host_dir`),
  not from Docker's `~/.docker/config.json`. nerdctl users who configured
  mirrors the nerdctl way would see different behaviour.

**On containerd 1.7, no.** Implement a registry client or shell out.

**Recommendation: shell out for the first version** (`nerdctl pull` or
`ctr -n <ns> images pull`, one process per image, cached by
`Images.Get` first so it only happens on a miss), and move to
`Transfer.Transfer` for anonymous pulls once containerd 2.x is a hard
requirement. `--pull=missing` semantics are then `Images.Get` +, on
`NOT_FOUND`, a pull.

---

## 5. The seam

### Why `Nerdctl` is the wrong one

`src/runtime/containerd/nerdctl.ts` is `exec(args)` and `stream(args)`. The
roadmap's "a direct containerd gRPC client behind the same `Nerdctl`
interface" would mean a gRPC implementation of `exec(['run', '-d', '--name',
'web', ...])`: parsing argv back into intent, then performing section 3. The
argv is a lossy, stringly-typed encoding of a call the caller already had in
structured form. It also cannot work for the pieces where gRPC has no
equivalent (`network create`) or a different shape (`events` is a typed
stream, not lines of JSON).

`RuntimeHandle` in `src/serve.ts` (`sink`, `idle`, `watch`, `synced`,
`prune`) is the right _shape_ but the wrong _level_: it is what `serve()`
needs from a runtime, and a gRPC containerd runtime would have to
reimplement all of the adoption, digest, ordering and prune policy that
`execute.ts` already gets right, just to offer the same five members. That
policy is not nerdctl-specific and should not be duplicated.

The seam belongs **between the executor and the transport**: one interface
with the operations `execute.ts` and `events.ts` actually perform, expressed
in containerd's terms rather than nerdctl's argv. `containerd()` then becomes
a `Runtime` that takes a driver.

```
serve() -> RuntimeHandle              (unchanged: sink, idle, watch, synced, prune)
             ^
             |  containerd({ driver })          policy: adoption, digests, ordering,
             |    execute.ts + events.ts        queueing, prune, probe scheduling,
             |                                  status writes
             v
           ContainerDriver             <- the new seam
             ^                ^
             |                |
     nerdctlDriver        grpcDriver   mechanism: how to actually do it
     (argv, parsing)      (protos, RPCs)
```

### The interface

Proposed for `src/runtime/containerd/driver.ts` (the version in
`spikes/grpc/src/driver.ts` is this, implemented):

```ts
export interface ContainerInfo {
  /** fiber-servo's name. On containerd this is the container id itself. */
  name: string;
  /** The runtime's own id: equal to `name` on containerd, 64-hex on nerdctl. */
  id: string;
  state: ContainerState;
  exitCode?: number;
  /** Value of the `fiber-servo.spec` label, for adoption by digest. */
  digest?: string;
}

export interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export interface NetworkInfo {
  name: string;
  digest?: string;
}

/** What a driver can do, so the executor refuses early and clearly. */
export interface DriverCapabilities {
  pull: boolean;
  networks: boolean;
  publish: boolean;
  exec: boolean;
}

export interface ContainerDriver {
  readonly kind: string;
  readonly capabilities: DriverCapabilities;

  /** Create and start are separate: START must restart a stopped container. */
  create(spec: ContainerSpec, labels: Readonly<Record<string, string>>): Promise<ContainerInfo>;
  start(name: string): Promise<void>;
  /** SIGTERM, then SIGKILL after `timeoutMs`. */
  stop(name: string, options?: { timeoutMs?: number }): Promise<void>;
  /** Stop if running, then delete. Absent is success. */
  remove(name: string): Promise<void>;
  inspect(name: string): Promise<ContainerInfo | null>;
  /** Everything carrying the managed label: the initial sync and prune(). */
  list(): Promise<ContainerInfo[]>;
  /** Readiness probes. Only `code` is used today. */
  exec(name: string, argv: readonly string[], options?: { timeoutMs?: number }): Promise<ExecOutcome>;
  /** Lifecycle, already reduced to what the status store takes. Ends on abort. */
  events(signal?: AbortSignal): AsyncIterable<StatusEvent>;

  createNetwork(spec: NetworkSpec, labels: Readonly<Record<string, string>>): Promise<void>;
  inspectNetwork(name: string): Promise<NetworkInfo | null>;
  listNetworks(): Promise<NetworkInfo[]>;
  removeNetwork(name: string): Promise<void>;

  close(): Promise<void>;
}
```

Design notes, each with a reason:

- **`events()` yields `StatusEvent`, not raw rows.** `StatusEvent` is already
  the neutral type (`{kind: 'set', name, state, exitCode?} | {kind: 'remove',
name}`) and `apply()` in `events.ts` already consumes it. The driver owns
  the id-to-name problem, which is where it belongs: nerdctl needs an index
  and an `inspect` fallback, the gRPC driver needs neither because the id is
  the name.
- **Everything is addressed by `name`.** Decision 3. `ContainerInfo.id` is
  informational.
- **`list()` returns state and digest**, so it serves three callers at once:
  the watcher's initial sync, `prune()`'s enumeration, and adoption.
- **`capabilities` is on the driver, not guessed by the caller.** It lets the
  executor turn "this driver cannot do networks" into one clear error at the
  `CREATE network` op instead of a confusing failure deeper down, and it lets
  `plan`/`up` warn about `publish` up front.
- **No `pull`.** Pull is part of `create()`: the driver decides whether that
  means `--pull=missing`, `Transfer.Transfer`, or shelling out.
- **`close()`** exists because a gRPC connection is a resource and nerdctl's
  is not; `stop()` in `serve()` already has a place to call it.

### What moves, exactly

From `src/runtime/containerd/execute.ts` (everything that touches
`nerdctl.exec`), into `nerdctlDriver`:

| Today                                                                                                          | Becomes                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `runArgs(spec)` and the `run()` that calls it                                                                  | `driver.create(spec, labels)`                                                                          |
| `inspect(name)` (the `{{.Id}} {{.State.Running}} {{index .Config.Labels ...}}` template)                       | `driver.inspect(name)`                                                                                 |
| `remove(name)` (`rm -f`, and the "no such container is success" rule)                                          | `driver.remove(name)`                                                                                  |
| the `start` half of `start(name)` (`nerdctl start`)                                                            | `driver.start(name)`                                                                                   |
| `managedContainers()` (`ps -a --filter label=... --format '{{json .}}'`)                                       | `driver.list()`                                                                                        |
| `managedNetworks()`, `networkIsManaged()`, `networkCreateArgs()`, `createNetwork`'s inspect, `removeNetwork()` | `driver.listNetworks()`, `driver.inspectNetwork()`, `driver.createNetwork()`, `driver.removeNetwork()` |
| the `nerdctl.exec(['exec', name, ...probe])` inside `probe()`                                                  | `driver.exec(name, argv)`                                                                              |

**Stays in `execute.ts`**, unchanged, because it is policy and not
mechanism: `specDigest()`/`canonical()`, the adopt-vs-recreate decision in
`create()`, "a vanished container is recreated from the last spec" in
`start()`, the `enqueue()` serialisation, `executeBatch()` and its
`status.set(dead, reason)` on failure, the `prune()` ordering
(containers before networks) and its per-resource error tolerance, the
`probe()` loop's scheduling and `status.mark()`, and the `specs` map.

From `src/runtime/containerd/events.ts`:

| Today                                                                            | Becomes                                                                                |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `syncFromPs()`                                                                   | `driver.list()`, applied to the store by `watchContainerd`                             |
| `parsePsLine()`, `parsePsStatus()`, `isManaged()`                                | private to `nerdctlDriver` (they parse nerdctl's output; nothing else should see them) |
| `interpretEvent()`, `EventRow`, `PsRow`                                          | private to `nerdctlDriver`, same reason                                                |
| the `resolve()` id-to-name cache and `notOurs` set                               | private to `nerdctlDriver`                                                             |
| the `while (!aborted) { sync; for await (stream) }` reconnect loop and `apply()` | stay in `events.ts`, over `driver.list()` and `driver.events(signal)`                  |

`interpretEvent` and friends are currently exported from `src/index.ts` (and
asserted directly by `test/containerd.test.tsx`). Moving them is a breaking
change to the public API, so step 1 below keeps them re-exported.

### Migration, in landable steps

Each step is independently shippable and leaves the suite green.

1. **Add the interface and the nerdctl driver, change nothing else.**
   New file `src/runtime/containerd/driver.ts` with the types above. New
   file `src/runtime/containerd/nerdctl-driver.ts` that implements
   `ContainerDriver` over the existing `Nerdctl`, by moving the argv-building
   and parsing functions into it. `execute.ts` and `events.ts` keep working
   through it. `nerdctl.ts` stays exactly as it is; it is the driver's
   transport now. Existing exports keep their names (re-export from the new
   home). _Test impact: none; `test/containerd.test.tsx` still drives a fake
   `Nerdctl` and still asserts argv, because the argv is still built._
2. **Thread the driver through `containerd()`.**
   `ContainerdOptions` gains `driver?: ContainerDriver`, defaulting to the
   nerdctl one. `createContainerdRuntime` and `watchContainerd` take a
   `driver` instead of a `nerdctl`. Add a `capabilities` check in
   `execute.ts`: a `CREATE network` on a driver with `networks: false` fails
   with a clear message, like the existing "networks are immutable" one.
   _Test impact: a fake driver becomes an easier way to write runtime tests
   than a fake nerdctl; existing tests can stay on the nerdctl driver._
3. **Land the gRPC transport, unused.**
   `src/runtime/containerd/grpc/` with the vendored protos, `protos.ts`,
   `client.ts`, `any.ts`, `oci.ts` -- the spike's files, with the deps moved
   to optional peer dependencies and the module imported lazily so nothing is
   loaded unless a gRPC driver is constructed. Ship the fake containerd as a
   test helper; it is what makes the rest testable in CI.
4. **`grpcDriver` for lifecycle only.**
   `create` (assuming the image is present), `start`, `stop`, `remove`,
   `inspect`, `list`, `exec`, `events`. `capabilities: {pull: false,
networks: false, publish: false, exec: true}`. Usable for a single-container
   app with a pre-pulled image; that is a real, if narrow, thing to ship.
5. **Image pull.** First by delegating to `nerdctl pull` behind
   `capabilities.pull`, then (optional, and only for containerd 2.x)
   `Transfer.Transfer` for anonymous references.
6. **Decide about networking on evidence.** By step 5 the gRPC driver is in
   real use for single-network-less apps, and the cost of CNI can be judged
   against how much anyone wants it. The honest default is: never; use the
   nerdctl driver when `<Network>` is in the tree.

A **hybrid driver** is a legitimate step 5.5 and is cheap once the interface
exists: a `ContainerDriver` that delegates `create`/`start`/`stop`/`remove`/
`inspect`/`list`/`exec`/`events` to the gRPC driver and
`createNetwork`/`removeNetwork`/pull to the nerdctl one. It is ~40 lines and
needs no new concepts, because both sides are the same interface.

---

## 6. Scope recommendation

**Build, in this order, and stop whenever the value runs out:**

1. `ContainerDriver` and the nerdctl driver (steps 1-2). Worth doing on its
   own merits, gRPC or not: it separates policy from mechanism, makes runtime
   tests independent of argv strings, is the seam a podman or docker driver
   would use, and is the only step that touches existing code.
2. The gRPC transport and a lifecycle-only gRPC driver (steps 3-4). This is
   where the wins are: no fork/exec per op (today a single `CREATE` is two to
   three process spawns), no Go-template output to parse, a typed event
   stream instead of line-delimited JSON, server-side label filters for
   `prune()`, and the id-to-name index disappearing entirely.
3. `exec` probes over gRPC (part of step 4). Cheap, and the hot path -- one
   probe per container every 2 seconds is a process spawn each today.

**Do not build:**

- **CNI networking and port publishing.** Section 4.1. This is nerdctl's
  entire value-add and reimplementing it is a different project. `<Network>`,
  `network=`, `publish=` and therefore `<Service publish>` keep using the
  nerdctl driver.
- **A registry client.** Section 4.4. Shell out, or require containerd 2.x
  and use `Transfer.Transfer`.

**So the answer to "hybrid?" is yes, and specifically:** gRPC for the
lifecycle (create/start/stop/remove/inspect/list), the event stream and exec
probes; nerdctl for image pull and everything with a network in it. The
argument is not aesthetic. The lifecycle half is a thin, stable, well-typed
API that containerd is designed to expose to clients. The other half is not
an API at all -- it is nerdctl's own implementation of things containerd
deliberately leaves out, and the only way to have it over gRPC is to write a
second nerdctl.

**And the honest recommendation about timing: not now.** Decision 9's
reasoning holds. The things this unlocks (fewer process spawns, typed events)
are performance and tidiness on a single-node tool where the number of
containers is small, while the things it costs (8.5 MB of dependencies, 14
vendored protos, a hand-written OCI spec to keep in step with containerd
releases, and a second code path for every runtime bug) are permanent. The
one step worth doing soon is the interface, because it is useful immediately
and it is what makes the rest a choice rather than a rewrite.

---

## 7. What the spike proved, and what it could not

`spikes/grpc/` runs under `npm test` (17 tests, ~1.3s, no containerd).
Details in [its README](../spikes/grpc/README.md); in summary:

**Proved**

- The 14 vendored protos load with `@grpc/proto-loader` with one include dir
  and no external protos beyond what protobufjs bundles.
- `unix:///run/containerd/containerd.sock` is the target; `containerd-namespace`
  is the header, and a call without it is refused.
- `Container.spec` is JSON under
  `types.containerd.io/opencontainers/runtime-spec/1/Spec`, and a hand-built
  spec carrying containerd's defaults round-trips through a real gRPC server.
- The create sequence is `Images.Get` -> `Snapshots.Prepare` ->
  `Containers.Create`, and the start sequence is `Tasks.Get` ->
  `Snapshots.Mounts` -> `Tasks.Create` -> `Tasks.Start`. A `Tasks.Create`
  without rootfs mounts is refused.
- `Events.Subscribe` envelopes unpack into exactly the body
  `interpretEvent` in `src/runtime/containerd/events.ts` already consumes:
  the same `/tasks/start` and `/tasks/exit` translations come out, unchanged,
  from gRPC input.
- `Events.Subscribe` really is cross-namespace without a filter.
- `Containers.List` with `labels."fiber-servo.managed"=="true"` filters
  server-side, which is what `prune()` needs.
- A readiness probe is `Tasks.Exec` + `Tasks.Start` + `Tasks.Wait` +
  `Tasks.DeleteProcess`, with empty stdio, and returns an exit code.
- **Two bugs a direct port would have shipped**, both found by writing the
  code rather than reading about it:
  - `/tasks/exit` decodes with `id: ''` when the shim omits the exec id (the
    proto documents `""` as "the init exec"); `interpretEvent` compares `id`
    to `container_id` and would drop **every** death, so the tree would never
    self-heal. The adapter has to rewrite `''` to the container id.
  - `/containers/delete` carries `id`, not `container_id`
    (`events/container.proto`), so a driver that only reads `container_id`
    produces an anonymous row and the store never forgets a deleted
    container.

**Not proved, and not provable this way**

- That the OCI spec in `spikes/grpc/src/oci.ts` is accepted by **runc**. It
  is a faithful transcription of containerd's defaults, not a tested spec.
  Nothing below containerd's API runs in the spike: no runc, no overlayfs, no
  process.
- Image pull, in any form. The transfer service is not vendored or exercised.
- Reading the rootfs chain id out of the content store: the spike takes it
  from a label the fake puts on the image record, which is the shape of the
  real answer but not the real lookup.
- Anything about CNI, published ports, DNS or `/etc/hosts`.
- Exec **stdio**. Only the exit code is proved.
- Real-daemon behaviour: a containerd restart mid-stream, backpressure on
  `Events.Subscribe`, slow shims, ttrpc, rootless containerd's different
  socket path and snapshotter.

A follow-up agent implementing this should expect the first real-host run to
be where the OCI spec and the snapshotter names get corrected, and should
budget for it.

---

## 8. Evidence

Everything above that cites containerd is from these sources, read rather
than recalled:

| Claim                                              | Source                                                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| namespace header `containerd-namespace`            | containerd 2.3.5 `pkg/namespaces/grpc.go`                                                                                                                                                 |
| ttrpc header `containerd-namespace-ttrpc`          | `pkg/namespaces/ttrpc.go`                                                                                                                                                                 |
| default address, runtime, snapshotter              | `defaults/defaults_linux.go`                                                                                                                                                              |
| OCI spec type URL and JSON encoding                | `core/runtime/typeurl.go` and `client/client.go` (`typeurl.Register(&specs.Spec{}, "types.containerd.io", ...)`), `github.com/containerd/typeurl/v2` `types.go` (`TypeURL`, `MarshalAny`) |
| the default spec, mounts, caps, namespaces         | `pkg/oci/spec.go`, `pkg/oci/mounts.go`                                                                                                                                                    |
| chain id label on the config blob                  | `core/unpack/unpacker.go`, `client/image.go`                                                                                                                                              |
| empty stdio means `/dev/null`                      | `cmd/containerd-shim-runc-v2/process/io.go`, `pkg/stdio/stdio.go`                                                                                                                         |
| `Events.Subscribe` is cross-namespace              | the rpc comment in `services/events/v1/events.proto`                                                                                                                                      |
| `id: ""` means the init exec                       | the `TaskDelete.id` comment in `events/task.proto`                                                                                                                                        |
| api module version for containerd 2.3.5            | containerd `v2.3.5` `go.mod`                                                                                                                                                              |
| 1.7 vs 2.x proto layout                            | api modules `v1.7.19` and `v1.11.1`, compared file by file                                                                                                                                |
| how nerdctl does CNI, hosts files and the OCI hook | nerdctl 2.3.5 `pkg/netutil/store.go`, `pkg/netutil/cni_plugin_unix.go`, `pkg/cmd/container/create.go`, `pkg/ocihook/ocihook.go`, `pkg/dnsutil/hostsstore/hostsstore.go`                   |

npm versions were checked against the registry on the day this was written
and installed into this tree.
