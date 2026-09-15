# Design decisions

This is a short record of the decisions that shape the current implementation.
Older experiments remain in Git history; [Architecture](architecture.md) is the
source of truth for the current design.

## React owns control decisions

- JSX is the desired tree.
- `ObservedStore` is the runtime read path and is consumed with
  `useSyncExternalStore`.
- `ReplicaSet`, `Deployment`, `Service`, and restart admission are React
  controller behavior. A runtime event can therefore produce a new commit.
- React commit publishes a complete snapshot and performs no runtime I/O.

## Resources and identity

- `name` is runtime identity. One `<Container>` maps to one Compose service.
- ReplicaSets use deterministic `<name>-<index>` names.
- Deployment generations use the full template digest for identity and a short
  digest only in names.
- A spec change always replaces the service. Live updates are outside scope.
- Networks are Compose resources and are not part of observed state.

## Runtime boundary

- `nerdctl compose` is the write path; containerd gRPC is the read path.
- The adapter receives a complete Compose model and must apply it idempotently.
- `serve.ts` schedules reconciliation and owns runtime I/O. It does not expand
  management resources or decide restart admission.
- Restart counters, rollout templates, and Ready latches are process-local.
  A control-plane restart converges to the current tree instead of resuming an
  interrupted rollout.

## Deliberate limits

- Single node and single writer.
- No persistent API server, cluster scheduler, Pod semantics, or sidecars.
- Service backend changes recreate the proxy and may interrupt traffic.
- External network drift is not detected.
- Readiness is a startup latch; a later dependency failure does not retract
  dependents.
