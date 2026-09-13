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
