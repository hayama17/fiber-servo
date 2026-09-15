# Design decisions

Short records of the choices that shaped the code, so they are not
relitigated by accident. Newest last.

## 1. spec = fiber tree, status = external store

**Decision.** Host instances are the desired state only. Runtime status lives
in a store outside the tree, read with `useSyncExternalStore`.

**Why.** If status were in the tree, every runtime event would be a tree
mutation and the reconciler could not be tested without a runtime. Keeping it
outside also makes the event source swappable: a test, a dummy runtime, or
`nerdctl events` all just call `store.set`.

**Consequence.** The tree can only _want_ things. Self-healing had to be
expressed as a desired restart generation (`restarts` prop) rather than as an
action.

**Precisely.** The rule is not "the tree is stateless". State lives in three
places, and the rule says which goes where:

1. React's own record of what it last committed: the current fiber tree and
   the host instances (`spec`, `restarts`, `created`, the `live` map). This is
   what render diffs against, exactly as the DOM renderer diffs against its
   memoized props and never re-reads the DOM. Policy state (self-heal
   counters, `Ready` latches) is here too.
2. The host's reality: containerd. React never looks at it; it assumes the
   host is what it committed, which holds for a DOM and not for a container
   that can die.
3. The observation of 2: the status store. Because React has no way to
   re-verify the host, the drift between 1 and 2 must come back as an
   _input_, next to props, so the tree can emit a new intention that React
   then diffs against 1.

In Kubernetes terms, React is the part of a controller that compares desired
state with its own cache, and the store is the informer. A process restart
loses 1 entirely; the runtime's `fiber-servo.spec` labels and the watcher's
initial `ps -a` rebuild what matters (see decision 10), and the self-heal
counters simply start over. Two processes reconciling the same containers
would each hold their own 1 and fight; one writer per host is assumed.

## 2. commit executes nothing

**Decision.** Every hostConfig method appends an op and returns. A sink
executes ops after the commit.

**Why.** React's commit must be synchronous and should not block on I/O.
Op lists are also the ideal test surface: assertions are literal sequences.

**Consequence.** `CREATE` is emitted at placement (`appendChild*`,
`insertBefore*`), not in `createInstance`, because the render phase can be
discarded and must not leak ops.

## 3. `name` is identity

**Decision.** Ops address resources by `spec.name`. Renaming a container
whose fiber React kept (same key and type) is `DELETE` old, `CREATE` new.

**Why.** The runtime has no other stable handle, and users need to find their
containers by name.

## 4. Deployment replicas are keyed by index

**Amended by decision 28.** The naming discipline survives; the expansion
moved from render time into the ReplicaSet controller.

**Decision.** `<Deployment>` clones its template with key and name
`${name}-${i}`.

**Why.** Scaling 3 to 5 must be exactly two `CREATE`s, and 5 to 2 exactly
three `DELETE`s. Index keys give that for free from React's reconciliation.

## 5. Every store event is one event

**Decision.** `store.set` bumps `seq` even when the state repeats. Snapshots
are immutable and stable between events.

**Why.** Two `dead` reports are two deaths; the self-heal hook answers each
`seq` at most once. Stable snapshots let `useSyncExternalStore` compare by
identity.

## 6. Restart bookkeeping is component state

**Superseded by decisions 22 and 27.** `useSelfHeal` is gone; restarts are a
controller's business and the backoff lives in the control loop.

**Decision.** Restart count, backoff, `maxRestarts` and the reset timer live in
`useSelfHeal`, not in the store or the runtime.

**Why.** They leave with the container when it leaves the tree, and they are
testable with fake timers. The runtime is told nothing but `START attempt=n`.

## 7. All updates are SyncLane

**Decision.** `resolveUpdatePriority` returns the discrete priority.

**Why.** A container spec has no "less urgent" changes. Sync lanes mean a
store event commits in the next microtask with no Scheduler involvement, and
`root.flush()` is deterministic in tests.

**Consequence.** Suspense retries still use React's retry lanes and the
Scheduler; `root.settle()` exists for them.

## 8. The executor reports only its own failures

**Decision.** The containerd executor writes `dead` (with a reason) when a
`run` or `start` is refused, and nothing else. Lifecycle comes from the
watcher.

**Why.** Two writers racing on the same id would produce spurious restarts.
A refused start is genuinely something only the executor sees, and reporting
it lets the tree retry with backoff instead of stalling.

## 9. nerdctl, not gRPC

**Amended by decision 29.** The conclusion held for writes and did not hold
for reads: the two halves are now split.

**Decision.** Drive containerd through the nerdctl CLI behind a two-method
interface (`exec`, `stream`).

**Why.** Direct gRPC needs OCI runtime-spec generation, image unpacking, and
vendored protos, none of which the project is about. nerdctl also brings CNI
networking and name resolution. The interface keeps a later gRPC client a
one-file swap, and lets tests drive the runtime with a fake.

**Alternatives.** `ctr` ships with containerd but has no networking. Docker
would have worked but the user prefers containerd.

## 10. Adoption by spec digest

**Decision.** Containers and networks carry a `fiber-servo.spec` label with a
digest of the spec they were created from. `CREATE` adopts a matching
resource, recreates a mismatching one.

**Why.** Restarting fiber-servo must not restart every container, and it must
converge if specs changed while it was down.

## 11. Networks are immutable

**Decision.** Changing a network field other than `name` emits an `UPDATE`
that the containerd runtime refuses.

**Why.** Recreating a network under attached containers is destructive and
nerdctl refuses it anyway. Renaming is explicit.

## 12. Readiness is a latch

**Decision.** `useReady` settles the first time a dependency runs and never
un-settles.

**Why.** Ordering is a startup concern; liveness is self-healing's. Re-suspending
a mounted subtree would hide containers (React calls `hideInstance`) without a
clear meaning for a runtime. Users who want to stop dependents can render
conditionally.

## 13. No fallback throttle

**Decision.** `scheduleTimeout` runs its callback on the next microtask.

**Why.** React delays the commit that replaces a Suspense fallback by about
300ms to avoid flashing. There is no UI; a gated container should be created
the moment its dependency is up. In concurrent mode that throttle is React's
only use of `scheduleTimeout`.

## 14. Nesting is dependency

**Superseded by decision 24.** Nesting now means ownership only. Dependency is
`<Ready on="...">` and network membership is a `network=` reference.

**Decision.** Children of a `<Container>` mount once it is running (or
`ready`, when it has a probe) and unmount before it. At the host level they
are siblings; `<Container>` wraps them in `<Ready>` itself.

**Why.** The tree shape should carry the topology: inside `<Network>` means
membership, inside `<Container>` means dependency. String references
(`<Ready on="db">`) stay available for dependencies that are not the parent,
but a typo in them is only found at runtime; nesting cannot be misspelled.
Nested host instances had no meaning on containerd, so nothing was lost.

**Consequence.** Dependents render before the container in tree order, so
React deletes them first on unmount. Dependents inside a `<Deployment>`
template are cloned per replica, like everything else in the template.

## 15. Readiness is a probe the runtime runs, marked into the store

**Decision.** `readiness={{ exec }}` is part of the spec. The containerd
runtime runs it with `nerdctl exec` while the container is running and not
yet ready, and `status.mark()`s `ready: true` on exit 0. The next lifecycle
event clears the mark. A dependent chooses what it waits for
(`until: 'running' | 'ready'`); a `<Container>` with a probe gates its
children on `ready` automatically.

**Why.** "Process started" is not "accepting connections". An exec probe
needs no network path from the host to the container and matches what most
images already ship (`pg_isready`, `redis-cli ping`). Making the condition
the dependent's choice avoids a registry of which containers have probes and
the race it would create between the watcher's `running` and the prober's
first result.

**Consequence.** The prober is a third status writer, next to the watcher
(lifecycle) and the executor (its own failures). It only amends a snapshot
it probed against, so a death during a probe wins.

## 16. Service is a proxy container built by composition

**Superseded by decision 25.** A proxy is still the data plane, but its
backends come from observed state rather than a render-time target list.

**Decision.** `<Service>` renders a `<Container>` running caddy with
`reverse-proxy --from :port --to target:port ...`. `<Deployment service>`
renders one for its replicas and updates its command when they change.

**Why.** It needs no new op, no new runtime code, and no config file; caddy's
`reverse-proxy` subcommand balances across several `--to` on its own. Scaling
becomes an `UPDATE` of the proxy's command, which the runtime already knows
how to apply. A DNS-based service would need a resolver the runtime does not
provide.

**Consequence.** Publishing a host port is a property of the proxy, not the
replicas, so replicas never collide on host ports.

## 17. One entry point, and a CLI over it

**Decision.** `serve(element, { runtime })` does the wiring that
`createRoot` leaves to the caller; `fiber-servo plan` and `fiber-servo up`
are thin commands over it.

**Why.** The JSX was declarative; the eight lines around it were not. `plan`
falls out of design rule #2: the dummy runtime plays a runtime that always
succeeds, so the full expansion (gated subtrees included) prints without
executing anything.

## 18. No API server: the file is the source of truth

**Historical decision, superseded in part by decision 20.** The file remains
the source, but explicit local apply now controls when it is evaluated.

**Decision.** There is no server to `apply` a desired state to. The desired
state is a program, `app.tsx`. A running `up` process evaluates it and
reconciles containerd to the result; `--watch` re-evaluates it on save.
Anything dynamic belongs in the program (hooks, external stores), not in a
remote call.

**Why.** Two reasons, one practical and one about the model.

- _Single node._ One host, one process, one writer. An API server earns its
  keep when several clients and several controllers must agree on one store.
  Here there is nothing to coordinate, and a store would be a second copy of
  the truth to keep in sync with the file.
- _React is functional._ Kubernetes stores desired state as data and lets
  controllers interpret it. fiber-servo stores it as a function and lets
  React evaluate it: `containers = f(props, observations)`. A function is not
  something you apply into a store; you run it. So the file that defines the
  function is the only sensible truth, and a running process is an
  evaluation of it, not a store. This is what makes
  `replicas={useSyncExternalStore(metrics)}` possible instead of a value
  someone must `PATCH`.

**Consequences.** `kubectl apply` becomes "save the file"; the CLI is a
GitOps-style agent for one file rather than a client of a server. There is
no remote control, RBAC, audit log or multi-client story, and none is
planned. Watch covers the entry file; modules it imports stay cached, so an
app is best kept in one file, or restarted. A multi-node fiber-servo would be
a different project that gives every node its own file.

**Alternatives.** A unix-socket `apply` into the running process was
considered. It turns the process into a second store and reopens the
question of which copy is true.

## 19. Identity is the name, not the fiber

**Superseded by decision 21.** The conclusion holds and is now structural: a
snapshot has no way to express "deleted then created", so there is no batch
left to normalise.

**Decision.** `resetAfterCommit` reduces a commit's ops to their net effect
per `kind:name`. DELETE followed by CREATE of the same name becomes an UPDATE
when the spec changed and nothing when it did not; CREATE followed by DELETE
is dropped. `DELETE` ops carry the last spec so the comparison is possible.

**Why.** React identifies subtrees by element type and key. A reloaded app
file (`--watch`) exports a new component function, so React unmounts the old
subtree and mounts the new one, and every container in it would be deleted
and recreated on every save. For the runtime that is wrong: the container
`web-0` with the same spec is the same container. Rule 3 already says the
name is the identity; this makes the ops honour it regardless of how React
arrived at them. Fast Refresh would preserve fiber identity instead, but it
needs every component registered by a compiler plugin, and the ops layer is
where identity for the runtime is decided anyway.

**Consequences.** Component-level state (self-heal counters, `Ready`
latches) does reset on a remount, because it belongs to the fiber; the
containers do not. A remount is therefore a cheap, observable no-op at the
runtime, and "force a recreate" needs a spec change, not a key change.

## 20. Explicit apply controls evaluation

**Decision.** `up` retains the live tree and exposes a local control endpoint.
`apply <app.tsx>` asks the owner of that canonical file to load and render it
again. `--watch` calls the same serialized operation automatically on entry-file
saves. The client sends no desired-state object and never evaluates the app.

**Why.** Saving source and changing the running environment are separate user
decisions. Explicit apply allows several edits to be completed before evaluation,
including changes made by an AI agent. React's functional composition and diffing
do not depend on whether a save or an explicit command triggered evaluation.
Decision 18 conflated an evaluation request with an independent state store;
the local endpoint adds the former without introducing the latter.

**Consequences.** The source file is the next program to evaluate; the running
tree represents its last evaluation plus ongoing hook state. Every load rebuilds
local imports; installed packages remain cached. Reloading remounts component
state, while decision 19 preserves same-name/spec runtime resources within a
commit. This is not Fast Refresh or an atomic deployment transaction.

Only one `up` owns an entry file. Apply/watch requests are serialized; shutdown
rejects new requests and drains accepted work before teardown. Success reports
queued execution, not readiness. Load failure preserves the old tree; render or
runtime failure can leave partial changes and is reported without rollback.
The default client timeout is two minutes and does not cancel accepted work.
Normal shutdown releases the endpoint. Forced termination may leave resources
and, on Unix, a stale socket; never unlink another live owner's endpoint.

**Scope.** This is a local trusted-user control channel, not a remote multi-user
API, durable scheduler, or security sandbox. No automatic adoption of another
session or replacement of a live listener is attempted.

## 21. A commit is a snapshot, not a list of operations

**Decision.** `resetAfterCommit` serialises the whole instance tree into a
`DesiredState` and publishes it. The hostConfig emits no ops and performs no
mount bookkeeping.

**Why.** An op stream is a diff, and a diff is only correct relative to a
state you are sure of. React is sure of what it last committed, but not of
what the runtime holds — a container can die, a process can restart, someone
can `nerdctl rm` by hand. So the op stream needed increasingly careful repair
to stay honest: `mountSubtree`/`unmountSubtree` tracking, `normalizeBatch`
collapsing delete-then-create back into an update, a `rename` path. Every one
of those was React compensating for not being able to see the host.

A snapshot makes the question go away. React states what should exist; the
control loop, which _can_ see observed state, works out the difference. All
the repair machinery deleted itself.

**Consequences.** Re-serialising the tree on every commit is O(tree) where the op
stream was O(changes). At one machine's worth of containers that is nothing,
and it buys a renderer with no hidden state. `collectSnapshots()` replaces
`collectOps()` as the test surface, and an assertion is now "these resources
should exist", which is easier to read than a sequence.

## 22. Runtime failures never re-enter the tree

**Decision.** A Pod dying is written to `observed.ts` and read by controllers.
Nothing about it reaches React. `useSelfHeal` and the `restarts` prop are
deleted.

**Why.** The old design answered a death by incrementing a restart generation
and passing it down as a prop, purely so React would see a changed value and
emit `commitUpdate`. That prop encoded an observation as an intention. Once it
existed there were two records of the same fact — what the tree said about
restarts and what the runtime had actually done — and keeping them agreeing
was work with no upside.

Under `<ReplicaSet replicas={3}>` the point is sharper: after a Pod dies the
JSX still says 3, and it is still _correct_. There is genuinely nothing for
React to re-render.

**Consequences.** Replacing a dead Pod costs zero React renders, which
`test/control-loop.test.tsx` asserts directly and `examples/replicaset.tsx`
prints. Restart policy is a `serve()` option rather than a prop, so it is set
per control loop instead of per container — a real loss of granularity,
accepted because per-container restart policy was never exercised.

## 23. A Pod is an infra container plus its members

**Decision.** `<Pod>` is the sandbox and the lifecycle boundary. On containerd
it is emulated CRI-style: an infra container owns the network namespace and
the published ports, and members join it with `--network=container:<pod>`.

**Why.** Pods are what makes the rest of the model coherent — a ReplicaSet
counts Pods, a Service routes to Pods, a sidecar shares its main container's
address. containerd has no Pod, but CRI's emulation is well understood and
costs one extra container per Pod.

**Consequences.** Published ports belong to the Pod, not the container, since
a container sharing a namespace cannot publish. Container-level networking is
not offered at all.

**Retired by decision 32.** There is no Pod. A container is the unit and maps
one-to-one onto a Compose service. What this decision got right is that a Pod
had to be _built_: neither containerd nor Compose has one, and the emulation
was ours to maintain. What it got wrong was the price — an extra container per
Pod, a naming scheme, a rule about which member may publish a port, and a
whole level of nesting in observed state, all in exchange for sidecars, which
nothing in the project used.

## 24. Ownership is nesting; everything else is a reference

**Decision.** JSX nesting means ownership only. A Pod joins a Network with
`network="backend"` and a Service finds Pods with `selector={{...}}`.

**Why.** Decision 14 made nesting mean membership _and_ dependency, which read
well until the graph stopped being a tree. A Pod owned by a ReplicaSet cannot
also be nested inside its Network, so one of the two relationships had to
become a reference anyway — and choosing by which is structurally an
ownership edge is the rule that stays consistent as more resource kinds
appear.

**Consequences.** `<Network>` no longer wraps anything, and a typo in a
`network=` or a selector is a runtime miss rather than a compile error. That
is the price of modelling a graph.

**Still current after decision 32**, with one level fewer in the tree: a
ReplicaSet now owns a `<Container>` template directly. The rule itself —
nesting is ownership, everything else is a name — is what let the Pod level be
removed without touching a single reference.

## 25. A Service selects; it does not list

**Decision.** `<Service selector={{ app: 'api' }}>`. Backends are resolved
from observed state by the Service controller.

**Why.** The previous `<Service targets={[...]}>` was computed at render time
by `<Deployment>`, which meant the backend set could only change when React
re-rendered. Pods appear and disappear without the tree changing, so the set
was wrong exactly when it mattered.

**Consequences.** A Service with nothing matching renders no proxy at all,
which is better than a proxy answering with 502. Control plane and data plane
are separable: replacing the caddy Pod with nftables changes one function.

The endpoint set is part of the proxy container's command, so every change to
it is a `replace-container` — visible as churn while replicas are still coming
up one by one. That is the immutability model behaving exactly as specified
rather than a bug, but it is also the clearest argument for a data plane that
can be reconfigured instead of recreated, and it is where the next Service
implementation should start.

## 26. The adapter records the spec it created from

**Decision.** `ObservedPod` carries `spec` (and `specDigest`), written into a
label by the adapter and read back by `inspect()`.

**Why.** Observation tells you what is running, not what was asked for. Given
only a live Pod and a desired spec you can tell _that_ they differ but not
_which field_ — and the whole immutability model turns on that distinction,
because a cpu change is an in-place update and an image change is a
replacement. Keeping the answer in the process would lose it on restart, so it
lives on the resource, which is also what makes adopting existing containers
possible (extending decision 10 from a digest to the spec itself).

**Consequences.** Any adapter mutation that changes a Pod's real spec must
rewrite the record, or the next reconcile sees a difference that is not there.
A Pod with no record is adopted rather than replaced: we do not delete what we
cannot prove we made.

**Amended by decision 31.** The mechanism survives and is now load-bearing for
the write path, but it carries _less_: a digest, not the spec itself. Under
Compose the answer to any difference is the same — remove that one service and
let `up` recreate it — so "which field changed" stopped being a question
anyone asks, and with it went `fiber-servo.spec-json` and the percent-encoding
it needed to survive a label column. What remains is `fiber-servo.spec`, an
hash, and the "adopt what we cannot prove we made" rule, which is unchanged.
(The hash itself was strengthened later; see decision 36.)

## 27. Backoff lives in the control loop

**Decision.** The restart gate is state in `serve()`. Controllers and the
planner are pure functions of (desired, observed).

**Why.** "How many times has this already failed" is neither desired state nor
observed state, so it has no home in either. Keeping it out of them is what
lets both be tested as plain functions over literals, which is most of the
test suite.

**Consequences.** The gate resets when a Pod stays up for `resetAfterMs`, and
it is lost on process restart — a crash-looping Pod gets a fresh budget after
a restart of fiber-servo. Acceptable, and the alternative is persisting
control-plane state, which decision 18 rules out.

## 28. Generation digest, then index

**Decision.** A Deployment's ReplicaSet is `${deployment}-${digest(template)}`
and its Pods are `${replicaSet}-${index}`.

**Why.** The digest makes a template generation self-identifying: an unchanged
template keeps its ReplicaSet, an edited one gets a new one, and no separate
revision counter has to be stored or incremented. The index keeps decision 4's
property that scaling 3 to 5 touches only the two new Pods.

**Consequences.** Names are deterministic, so a restarted fiber-servo computes
the same ones and adopts its own Pods. A trivial template edit (reordering
env keys is normalised away, but a whitespace change in a command is not)
triggers a rollout, which is the honest reading of "the template changed".

## 29. Writes through nerdctl, reads through containerd's API

**Decision.** Mutations (`run`, `rm`, `update`, `network create/rm`) keep
going through the nerdctl CLI. State is read from containerd's own gRPC API —
`Containers`, `Tasks` and `Events` — with its `.proto` files vendored into the
repo. Networks are read from CNI configuration files, because containerd has
no notion of one.

**Why.** Decision 9 weighed gRPC against nerdctl as a single choice and
answered for the whole adapter. That was one question too few: the two halves
have almost nothing in common.

Writing genuinely needs what nerdctl brings. Creating a container means
resolving and unpacking an image, generating an OCI runtime spec, attaching
CNI, and programming published ports. Reimplementing that is a project in
itself, and it is not this project.

Reading needs none of it, and pays for the CLI three times over:

- _Wording is a contract nobody agreed to._ `nerdctl inspect --format` answers
  with a string, and "does this error mean it is already gone" is a guess
  about phrasing. `removeNetwork` shipped broken for exactly this reason: the
  test fake answered `no such network`, a string nerdctl never emits, so the
  suite passed and the adapter threw against the first real daemon it met. A
  field is not open to interpretation.
- _A process per read._ `Containers.List` measures about 20ms against the
  local socket; forking nerdctl costs several times that, and a reconcile pass
  reads once per Pod.
- _Events arrive typed._ `Events.Subscribe` delivers a container id and an
  exit status in fields, replacing a line-oriented parse of `nerdctl events`
  output — the most fragile code in the old adapter.

**Consequences.** Three runtime dependencies (`@grpc/grpc-js`,
`@grpc/proto-loader`, `protobufjs`) and 88K of vendored Apache-2.0 `.proto`
files. They are vendored rather than fetched because they are the wire
contract state is decoded through, and an `npm install` should not be able to
change that quietly; `tsc` does not copy them, so the build carries them into
`dist` explicitly.

The adapter now talks to containerd two ways at once, which is a real cost in
comprehension, paid for by never parsing a sentence again.

**The one exception.** A Pod's IP address is a CNI result, not containerd
state, so it is still read with `nerdctl inspect`. It is the only surviving
read, and it is marked as such in the code.

**Scope.** `Images`, `Snapshots` and everything else containerd exposes stay
unused; only the three services actually read are vendored. Writing over gRPC
remains out of scope, and decision 9's reasoning for that is unchanged.

**Amended by decisions 30 and 33.** The read half is exactly right and is kept
whole. The rest of this decision does not survive:

- _Networks from CNI files_ is gone. It replaced parsing something
  user-facing with parsing something private, and the answer was in a
  container label (`nerdctl/networks`) the whole time. Networks are Compose's
  to create and remove.
- _The one exception_ is gone with it. Compose sets a container's hostname to
  its service name, so a `<Service>` proxy targets `api-0:8080` by name and
  nothing needs an IP address. `nerdctl inspect` has left the adapter
  entirely.
- _Writes through nerdctl_ is still true of the process being run, but the
  vocabulary is now `compose`, not `run`/`rm`/`network create`.

The justification given here for keeping the CLI on writes was also wrong on
its own terms: it cited the `removeNetwork` wording bug, but that bug was in a
_write_ path, so moving reads to the API could never have prevented it. The
wording argument stands as an argument about reads; it was never an argument
about the seam.

## 30. Compose is the write path

**Decision.** fiber-servo does not create containers. It produces a **Compose
application model** — services, networks, labels — and `nerdctl compose`
applies it. The adapter's whole write vocabulary is `apply(model)` and
`down()`. There is no `createContainer`, no `startTask`, no argv built from a
spec.

**Why.** The previous adapter decomposed every spec into a `nerdctl run`
invocation: flag by flag, it re-implemented the front half of Compose. That
put fiber-servo in the business of image resolution policy, port syntax, CNI
attachment and the order in which a sandbox and its members come up — none of
which is what this project is about. The project is about **React as a control
plane**. Everything below "what should exist" is someone else's solved problem.

It also settles what fiber-servo _is_: a layer between Compose and Kubernetes.
Compose describes an application but has no controller — it cannot count
replicas, roll a new generation out, or bring a dead container back on its
own. Kubernetes has all of that and a cluster's worth of machinery around it.
fiber-servo keeps the controllers and hands the application to Compose.

**Consequences.**

- The immutability model largely moves into the actuator. Changing an image
  means removing that one service and letting `up` recreate it; fiber-servo
  keeps only the decisions Compose cannot make — how many replicas, which
  generation, when to roll.
- `fiber-servo plan` prints the Compose model, which is better than an action
  list because it is literally what will be applied.
- Sidecars go (decision 32), as does anything else Compose has no word for.
- The word "service" now means two things. `ComposeService` — a container
  definition — lives in `src/compose.ts` and nowhere else; `<Service>` stays
  the Kubernetes-style endpoint it always was. Two meanings for one word in one
  codebase is how a reader gets lost, so the boundary is enforced by which file
  a name may appear in.

## 31. `compose up` is not idempotent, so `apply` is two steps

**Decision.** `apply()` runs `compose rm -f -s <service>` for each service
whose recorded digest differs from the desired one, then
`compose up -d --no-recreate`.

**Why.** Measured against nerdctl 2.1.2, not assumed. A plain `compose up -d`
on an **unchanged** model re-creates every container — every id changes.
Docker Compose compares a config hash and reports "up-to-date"; nerdctl does
not implement that. Under a level-triggered loop that would churn the entire
application on every pass, for ever.

`--no-recreate` fixes it, and does more than its name suggests:

| command                                  | behaviour                                      |
| ---------------------------------------- | ---------------------------------------------- |
| `compose up -d`                          | recreates everything, always — unusable here   |
| `compose up -d --no-recreate`            | zero re-creations, ids stable — idempotent     |
| the same, after `nerdctl kill`           | runs `start` on the dead one — self-healing    |
| `compose rm -f -s <svc>`, then the above | replaces that service only                     |
| `compose down`                           | removes the containers and the project network |

So step two alone creates what is missing and restarts what died; step one is
what makes a _changed_ spec take effect. Which services changed is decided by
comparing the desired digest against the `fiber-servo.spec` label read back
from containerd — decision 26's mechanism, now carrying the write path too.

**Consequences.** One measurement invalidated the premise the design had been
approved with, which is the argument for running the actuator by hand before
building on it. A service being removed must still appear in the file handed
to `-f`, or `compose rm` answers "no such service" — so `apply()` writes the
model plus a stub entry for each orphan, removes them, then rewrites the file
as the model itself.

## 32. There is no Pod; the container is the unit

**Decision.** `<Pod>` is removed. `<ReplicaSet>` and `<Deployment>` own a
`<Container>` template directly, and `network`, `labels` and `publish` move
onto `ContainerSpec`. One container is one Compose service.

**Why.** A Pod buys exactly one thing: several containers sharing a network
namespace. Compose has no Pod, containerd has no Pod, and the emulation
(decision 23) was ours to build and maintain — an infra container per Pod, a
naming scheme, a rule about which member may publish a port, a level of
nesting in every observed-state type, and an entire file of name assembly.
Nothing in the examples used a sidecar.

Removing it collapses the model onto the one Compose already has, which is
what makes decision 30 cheap rather than a translation layer.

**Consequences.** Sidecars are gone and are not coming back through the front
door; a future one would be a Compose feature (`network_mode:
service:<name>`), not a fiber-servo resource kind. `ObservedState` flattens to
a map of containers. `<Ready on="db">` names a container. A ReplicaSet still
counts, a Service still selects — neither ever cared what a Pod was.

## 33. The seam is ownership, not read-versus-write

**Decision.** The runtime boundary splits by **who owns the resource**:
Compose owns containers and networks and is written to; containerd owns what
is actually running and is read from. containerd is never mutated —
`Containers.Create/Update/Delete`, every `Tasks` write, image pull, snapshot
creation and namespace creation are all out of bounds, and the observer has no
code that could perform one.

**Why.** Decision 29 split by read-versus-write, and the shape of the result
is what gave it away: three transports to one dependency (the nerdctl CLI,
containerd's gRPC API, and nerdctl's on-disk CNI files), and a headline rule
with an exception at the very first requirement. A rule that needs an
exception to state is usually the wrong cut.

Ownership makes the same three parties fall out cleanly, and each gets one
transport:

```text
fiber-servo   decides what should exist         React + controllers
nerdctl       makes it so                       compose up / rm / down
containerd    says what is actually running     Containers, Tasks, Events
```

Writing through Compose while reading underneath it is not a layering
violation, because the two answer different questions. Compose answers "did
the application get applied"; containerd answers "is this process alive right
now, and with what exit code" — which is the input a control loop needs, at the
rate it needs it, and which no CLI invocation can deliver as a stream.

**Consequences.** One configuration object owns both halves: the namespace
goes to `nerdctl --namespace <ns> compose` _and_ into the gRPC
`containerd-namespace` metadata, because a read path pointed at a different
namespace than the write path would observe an empty world and reconcile
for ever. The socket address is configurable for the same reason rootless
containerd exists.

## 34. Everything is a replacement now

**Decision.** There is no in-place update. Any difference between a desired
`ContainerSpec` and the one a container was created from — image, command,
env, network, labels, published ports, **and now cpu and memory** — is
answered the same way: remove that one service and let `compose up` recreate
it.

**Why.** The in-place path existed because containerd can change a cgroup
limit under a running process, and `nerdctl update` exposed it. Compose has no
live-update primitive at all: the model describes what should exist, and the
way a changed model takes effect is that the container is made again. Keeping
an in-place branch would mean reaching past the actuator to mutate something
it believes it owns, which is precisely the seam decision 33 draws.

**Consequences.** Raising a memory limit now restarts the process. That is a
real loss and it should be stated rather than discovered: it is the price of
having one write path instead of two, and of the planner no longer needing to
know _which_ field changed — a digest comparison answers "same or different",
and nothing above the adapter asks anything finer. Decision 26's recorded spec
shrinks to that digest for the same reason.

## 35. A probe is bounded, and teardown does not depend on it

**Decision.** `ReadinessProbe.timeoutMs` (default 2000) bounds every attempt,
and the timeout kills the probe's process _group_. `Runtime.down()` restores
the last model that declared anything before asking Compose to remove it.

**Why.** Both came out of running the thing on a live daemon, and neither was
visible from reading it.

A readiness probe is, by construction, run against a container that might be
unwell — so "the probe does not return" is the ordinary case, not an exotic
one. Unbounded, it costs more than a late answer: `nerdctl exec` holds the
container's exec lock, so the `compose rm` that teardown issues blocks behind
it and **Ctrl-C never completes**. Measured: still running after 31 seconds
before, 3 seconds after.

The first attempt at the fix did not work, for a reason worth keeping: killing
the direct child is useless when that child is itself a parent. `nerdctl
compose exec` runs `nerdctl exec`, the grandchild inherits the stdout pipe,
and Node's `close` event waits for the pipe — so the process was signalled and
the call still waited out the full sleep. The probe child is spawned
`detached` and the timeout signals the group.

The second is smaller and the same shape. `compose down` removes the networks
declared by the file it is handed, and `serve().stop()` unmounts first, so by
the time `down()` runs that file has been reduced to the empty model. The
application came down; its network stayed on the machine.

**Consequences.** A probe that legitimately takes longer than two seconds must
say so. That is the right default to get wrong in this direction: a probe
answering late is reported as not-ready and retried, while a probe answering
never used to take the whole control plane with it.

**The general lesson**, which is why this is a decision and not a bug fix:
every one of these is a case where fiber-servo trusted a subprocess to finish.
The two reconcilers are level-triggered precisely so that a _missed_ answer
costs a late reconcile — but a _blocked_ one costs everything, because no
later pass ever runs. Anything this project waits on needs a bound.

## 36. A digest is identity, so it is SHA-256

**Decision.** `digest()` is SHA-256, 64 hex characters, and it is what
`fiber-servo.spec`, the restart gate and every "is this still the same spec"
comparison use. Where a digest has to be part of a _name_ — a Deployment
generation, and so a ReplicaSet and container name — `shortDigest()` takes the
first 16 characters, and it is a separate function on purpose.

**Why.** The original was 32-bit FNV-1a rendered as eight hex characters, and
the comment justifying it said a collision "only costs an unnecessary
rollout". That had the failure backwards. Nothing in this design ever asks
"which field changed"; it asks "same or different", and answers every
difference the same way. So a collision does not cause an extra rollout — it
causes a rollout that **does not happen**: a container keeps running the old
image, the plan reports nothing pending, and no layer anywhere can notice,
because the digest was the only question asked.

Thirty-two bits is also not much room. A few tens of thousands of distinct
specs — across a machine's history, not at one instant — make a collision
likelier than not, and the specs here are highly similar strings, which is
exactly where a cheap hash is weakest.

**Consequences.** `digest()` now needs `node:crypto`, which `resources.ts` did
not previously import; the package was already Node-only. Container names grow
by eight characters (`web-43bfee23-1` becomes `web-43bfee23d1cb5f62-1`) —
still readable in `nerdctl ps`, and 64 bits is far past where an accidental
collision between the handful of generations one Deployment ever has is worth
thinking about.

**The split is the point.** Keeping `shortDigest` a separate function is what
stops a readability decision about names from quietly becoming a correctness
decision about identity. The truncation happens where a human reads it, and
nowhere else.

## 37. Template history lives beside the application, not on the container

**Decision.** A container's labels carry only small, fixed-width identifiers —
who owns it, which generation it belongs to, the digest of its spec, and its
readiness probe. The mapping from a generation to the `ContainerTemplate` it
was made from lives in a small JSON file (`src/generations.ts`), written by
`fiber-servo up` and read back at startup.

**Why.** Decision 26 says state belongs on the resource, because state on the
resource cannot desynchronise from it. That is still the better instinct, and
here it is simply not available: containerd rejects any label whose key and
value together exceed 4096 bytes. Measured against containerd 2.2.2 — 6015
bytes refused, two labels of 3000 bytes accepted, so the limit is per pair,
not across the set.

A container spec with a few kilobytes of environment is ordinary. Carrying the
template in a label made such a spec **impossible to create**: `create
container failed validation: label key and value length (17816 bytes) greater
than maximum size (4096 bytes)`. A feature that turns a valid spec into an
unlaunchable one is not a trade-off, and no amount of encoding cleverness
fixes an unbounded value in a bounded place.

**Consequences, including the one that is a real loss.** The file can go
missing while the containers it describes are still running — a fresh machine,
a cleared state directory — which a label could never do. The window is
narrower than it looks: the store is consulted only for generations _other
than the one currently declared_, so an application that is not mid-rollout
never reads it. What it costs is that a rollout interrupted by losing the
store finishes abruptly rather than gradually, because `expandDeployment`
refuses to invent a template it cannot verify (`shortDigest(template)` must
equal the id it is filed under). The failure mode is "the rollout finishes
sooner", never "a container comes back as something nobody asked for".

Two smaller consequences worth stating. The library does not write to disk by
default: `serve()` uses an in-memory store, and only `fiber-servo up` — the
one long-lived caller, and the only one for which surviving a restart means
anything — passes a file-backed one. And every failure in that file is
survivable: unreadable, corrupt, or filed under the wrong id all mean "start
empty and say so", because losing a rollout's gradualness must never cost the
application its availability.

## 38. "Level-triggered" is a claim about containers

**Decision.** The self-healing guarantee — every pass recomputes from
observed state, so a missed event costs a late reconcile and never a wrong
one — is scoped in the documentation to **containers**. Network drift caused
outside fiber-servo is explicitly not detected, and not self-healed.

**Why.** The guarantee rests on there being an observation to recompute
against, and for networks there is not. Decision 30 gives their lifecycle to
Compose, so `ObservedState` carries none — there is no field in which "the
network is gone" could even be expressed. `Plan.networks` is therefore
computed against the last model _this process applied_, which detects changes
to what was asked for and nothing else.

So the honest statement is narrower than the one the README made:

- a network added, removed or edited in the tree — detected
- a network missing when fiber-servo starts — applied, because a fresh
  process has no previous model and treats everything as new
- a network someone removes with `nerdctl network rm` while fiber-servo runs
  — **not** detected, until something else causes an apply or the process
  restarts

**Why say it rather than fix it.** Observing networks means deciding what
fiber-servo is entitled to know about a resource Compose owns, and the last
time this project inferred a runtime's private state it read nerdctl's CNI
files and got decision 29 wrong for it. That is a design question, not an
oversight to patch, and it is left open deliberately. What is not acceptable
is a documented guarantee the implementation does not make, so the
documentation moved to meet the code, and one test pins the current behaviour
so the two cannot drift apart again.
