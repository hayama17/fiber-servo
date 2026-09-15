# Project scope

fiber-servo is an experiment in using React Fiber to control a Compose
application on one machine. Keep it small enough to understand the role of
React, the controllers, and the runtime adapter.

The implemented design lives in [Architecture](docs/architecture.md); its
rationale and history live in [Design decisions](docs/decisions.md).

## Non-goals

- Multi-node scheduling, cluster membership, and distributed consensus.
- A persistent API server or Kubernetes API compatibility.
- Overlay networking and NetworkPolicy.
- Pod semantics and sidecar orchestration.
- A dynamically reconfigured Service proxy. Backend changes replace the proxy;
  traffic interruption is accepted to keep the experiment small.

## Open question

Should network drift be observed? Currently only changes to network
declarations are detected; external changes are not self-healed.
