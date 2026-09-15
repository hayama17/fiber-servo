# Design decisions

Numbered records preserve the reasons for the design. Historical and amended
entries identify their replacements; [Architecture](architecture.md) describes
the current implementation. Decision numbers and headings are kept stable for
existing references. Earlier versions remain in Git history.

## 1. spec = fiber tree, status = external store

Desired specs belong to the React tree; observed runtime state belongs to an
external store read through `useSyncExternalStore`. This keeps rendering
independent of runtime I/O. The original restart-prop mechanism was replaced
by controllers in decisions 21–22.

## 2. commit executes nothing

React commit performs no runtime I/O because it must remain synchronous.
The original op list and sink were replaced by desired snapshots in decision
21; the no-I/O rule remains.

## 3. `name` is identity

Resource names are runtime identity. Renaming changes which resource is
wanted; changing React keys alone does not force runtime replacement.
Decision 21 replaces the original DELETE/CREATE implementation.

## 4. Deployment replicas are keyed by index

**Amended by decisions 28 and 32.** ReplicaSet controllers now generate
`<name>-<index>` Container names. Scaling preserves existing indices instead
of replacing unchanged replicas.

## 5. Every store event is one event

**Historical.** The old status store incremented a sequence for every event
to drive self-healing hooks. Decision 22 removed that consumer; current
observations use the external store described in Architecture.

## 6. Restart bookkeeping is component state

**Superseded by decisions 22 and 27.** Restart counters and backoff moved
from `useSelfHeal` into the control loop. Runtime failures no longer require
synthetic desired-state changes.

## 7. All updates are SyncLane

Desired updates use discrete priority for deterministic commits without a
UI scheduling policy. Suspense retries still use React's retry lanes;
`root.settle()` waits for them.

## 8. The executor reports only its own failures

**Historical.** The op executor reported failed starts; the watcher reported
lifecycle changes. With the Compose adapter, apply failures are errors and
runtime observations come from gRPC and readiness probes.

## 9. nerdctl, not gRPC

**Amended by decisions 29–33.** nerdctl handles runtime writes; containerd
gRPC supplies observations. Delegating writes avoids implementing image
unpacking, OCI specs, and networking in fiber-servo.

## 10. Adoption by spec digest

Record a spec digest on containers so matching resources survive a
control-plane restart. Network digest labels from the original design are
retired; networks are delegated to Compose (decision 30).

## 11. Networks are immutable

**Historical.** The pre-Compose adapter rejected network updates. Network
configuration now goes through Compose; a planned network change is not a
guarantee of replacement. See Architecture's reconciliation limits.

## 12. Readiness is a latch

`useReady` settles once the dependency satisfies the requested condition.
Later failure does not retract dependents: startup ordering and recovery
are separate concerns. Conditional rendering can express other policies.

## 13. No fallback throttle

Schedule Suspense fallback timeouts on the next microtask. A renderer without
a visible UI does not need React's delay for avoiding fallback flashes.

## 14. Nesting is dependency

**Superseded by decision 24.** Network nesting once meant membership and
Container nesting meant dependency. Nesting now means ownership; network
membership and startup ordering use explicit references.

## 15. Readiness is a probe the runtime runs, marked into the store

Readiness is an exec probe declared in the spec and run by the adapter.
Exit 0 marks the observed container ready. A stale probe result must not
restore readiness after removal. Automatic Container-child gating was
removed; use `<Ready until="ready">`. See decision 35 for timeouts.

## 16. Service is a proxy container built by composition

**Amended by decision 25.** A Caddy container provides the Service data plane.
Publishing a host port on the proxy avoids collisions between replicas.
Render-time target lists were replaced by observed-state selectors.

## 17. One entry point, and a CLI over it

`serve(element, { runtime })` wires the renderer, store, and control loop.
The CLI uses that entry point; `plan` expands against the memory runtime,
including Ready-gated children. It evaluates app code but does not apply to
containerd.

## 18. No API server: the file is the source of truth

**Amended by decision 20.** Desired configuration is a program in a file,
not a persistent API-server object. A local evaluation request does not
introduce another desired-state store. No remote multi-user API is planned.

## 19. Identity is the name, not the fiber

**Implemented structurally by decision 21.** Reloading may remount React
components, but a resource with the same name and spec remains the same
runtime resource. Component state, including Ready latches, can still reset.

## 20. Explicit apply controls evaluation

`up` owns a local endpoint for the canonical app file. `apply` requests a
serialized reload; `--watch` uses the same operation on entry-file saves.
Saving and applying are separate choices. Loads rebuild local imports while
installed packages remain cached; reloads remount component state.

Load failure preserves the old tree. Render or runtime failure may leave
partial changes without rollback; success does not mean readiness. A client
timeout (default two minutes) does not cancel accepted work. Shutdown rejects
new requests and drains accepted work before teardown.

This is a trusted local control channel, not a remote API or sandbox. Only
one session owns an entry file. Forced termination can leave a Unix socket;
never remove another live owner's endpoint.

## 21. A commit is a snapshot, not a list of operations

`resetAfterCommit` publishes the whole `DesiredState` rather than operations.
The control loop compares that snapshot with runtime observations, without
repairing React's assumptions about the host. Serialization is O(tree),
accepted for a single-node application; `collectSnapshots()` is the test surface.

## 22. Runtime failures never re-enter the tree

Controllers handle container failures from observed state; `useSelfHeal` and
the `restarts` prop were removed. An unchanged replica count needs no React
render to recover. Hooks may still read observations for explicit policies
such as Ready. Restart policy is per control loop, not per container.

## 23. A Pod is an infra container plus its members

**Retired by decision 32.** Pod sandboxes were emulated with an infra
container and shared network namespaces. Unused sidecars did not justify the
extra container, naming, and nested state.

## 24. Ownership is nesting; everything else is a reference

Nesting expresses ownership. Network membership uses a name and Service
membership uses labels, because those relationships form a graph rather than
a tree. References can fail to match at runtime. After decision 32,
ReplicaSets own Container templates directly.

## 25. A Service selects; it does not list

Resolve Service backends from observed containers so membership can change
without a React render. No matching endpoints means no proxy. The endpoint
set is part of the proxy command, so backend changes replace it and may
interrupt traffic. This is accepted to keep the experiment small; dynamic
proxy reconfiguration is outside the current scope.

## 26. The adapter records the spec it created from

**Amended by decisions 31 and 34.** The adapter records the creation spec's
digest on the container. A full recorded spec was needed for field-specific
updates; uniform replacement only needs equality. Rollout templates are not
stored in labels (decisions 37 and 40).

## 27. Backoff lives in the control loop

Restart backoff belongs to the control loop: failure counts are neither
desired configuration nor runtime observations. Controllers remain pure.
Counters reset after a sufficiently long run, a spec change, or a
control-plane restart.

## 28. Generation digest, then index

Use deterministic generation and replica names so unchanged templates and
indices retain identity. Decisions 36 and 39 distinguish the full generation
digest from its shortened name. Decision 32 changes the unit from Pod to
Container.

## 29. Writes through nerdctl, reads through containerd's API

Use containerd's typed Containers, Tasks, and Events APIs for observations,
avoiding CLI processes and text parsing per read. Vendored protobufs keep the
wire contract in the repository and are copied into the build.

**Amended by decisions 30 and 33.** Direct nerdctl runtime commands, private
CNI-file reads, and IP lookups were removed. Compose is the write path;
Service backends use service names.

## 30. Compose is the write path

Controllers produce a complete Compose application; the adapter applies it.
Image handling, container creation, and network attachment stay with Compose.
A `ComposeService` is a container definition; JSX `<Service>` is an endpoint
policy. Networks have no observed-state model (decision 38).

## 31. `compose up` is not idempotent, so `apply` is two steps

Use `compose rm -f -s` for changed and orphaned services, then
`compose up -d --no-recreate`. In the recorded nerdctl 2.1.2 verification,
plain `up -d` recreated unchanged containers; `--no-recreate` preserved them
and restarted stopped containers.

Removal targets must exist in the Compose file, so orphan stubs are written
for `rm` and removed before `up`. Skip `up` for a model with no services.
The [adapter guide](containerd.md) specifies the sequence.

## 32. There is no Pod; the container is the unit

One Container maps to one Compose service. Removing the unused Pod sandbox
eliminated infra containers, special naming, and nested observed state.
Sidecar orchestration is outside the current scope.

## 33. The seam is ownership, not read-versus-write

Compose owns application mutations; containerd gRPC supplies runtime
observations and performs no mutation RPCs. Resolve namespace and socket once
for both paths. The Compose project used for writes must match the one
filtered by reads, or reconciliation would repeatedly see missing resources.

## 34. Everything is a replacement now

Every Container spec change, including CPU and memory, replaces the service.
This keeps one Compose write path and one digest comparison. Raising a memory
limit therefore restarts the process; live resource updates are not supported.

## 35. A probe is bounded, and teardown does not depend on it

Bound readiness attempts with `timeoutMs` (default 2000) and kill the process
group on timeout. Killing only the Compose parent leaves its exec child
holding pipes and locks, which can block teardown.

Keep the last nonempty model for `down()`: after the final empty apply, it
still supplies the network declarations Compose needs for cleanup.

## 36. A digest is identity, so it is SHA-256

Use SHA-256 for spec equality. A digest collision could suppress a required
replacement, not merely cause an extra rollout. `shortDigest()` takes 16 hex
characters for readable names; full digests remain the comparison keys.
Decision 39 completes that separation for generations.

## 37. A template does not fit in a container label

Do not store rollout templates in container labels. Verification against
containerd 2.2.2 found a 4096-byte limit per key/value pair: one 6015-byte
pair failed, while two 3000-byte labels succeeded. A normal template can
exceed that limit. Readiness metadata is also subject to label size limits.

**Superseded by decision 40 for storage.** An intermediate JSON-file solution
was removed; rollout templates now remain in memory.

## 38. "Level-triggered" is a claim about containers

Network plans compare declarations against the previous model, not the
machine. External network drift is therefore not detected or self-healed.
Adding network observation remains an open design question.

Container reconciliation also depends on fresh observations: the current
adapter resyncs on subscription and stream failure, not periodically while
the stream is healthy. See [Architecture](architecture.md) for the exact scope.

## 39. A generation's identity is the full digest; its name is the short one

Generation labels, grouping, and template-history keys use the full digest.
Only ReplicaSet and Container names use the short form. Do not recover
generation identity by parsing a name. A short-name collision still produces
duplicate resource names, which `runControllers` rejects; it is not harmless.

## 40. Controller history does not go into runtime metadata

Keep past generation templates in memory for the control loop's lifetime,
alongside backoff and other controller bookkeeping. Persisting only rollout
history gives it a different lifetime and adds another record to reconcile.

After restart, missing current resources are created and unwanted old ones
are removed. An interrupted rollout does not resume gradual draining.
The guarantee is convergence to current desired state, not rollout continuity.
