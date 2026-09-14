/**
 * Public API, grouped the way the architecture is layered.
 *
 *   components    what you write        JSX -> desired state
 *   resources     the vocabulary        the specs every layer speaks
 *   controllers   management -> runtime Deployment -> ReplicaSet -> Pod
 *   planner       desired vs observed   what must change, and whether in place
 *   runtime       the adapter           the only layer that knows how
 *   serve         the control loop      ties the two reconciliations together
 */

// ---- what you write --------------------------------------------------------
export { Container, Deployment, Network, Pod, Ready, ReplicaSet, Service } from './components.js';
export type {
  ContainerProps,
  DeploymentProps,
  NetworkProps,
  PodProps,
  ReadyProps,
  ReplicaSetProps,
  ServiceProps,
} from './components.js';

// ---- the vocabulary --------------------------------------------------------
export { RESOURCE_KINDS, digest, resourcesOfKind, selectorMatches, specValueEquals } from './resources.js';
export type {
  ContainerSpec,
  DeploymentSpec,
  DesiredState,
  NetworkSpec,
  PodSpec,
  PodTemplate,
  PortMapping,
  ReadinessProbe,
  ReplicaSetSpec,
  Resource,
  ResourceKind,
  ResourceLimits,
  ResourceOf,
  RolloutStrategy,
  ServiceSpec,
  Specs,
} from './resources.js';

// ---- React ------------------------------------------------------------------
export { EMPTY_DESIRED, collectSnapshots, createRoot } from './reconciler.js';
export type { CreateRootOptions, Root } from './reconciler.js';
export { podSatisfies, readyThenable, useObserved, usePod, useReady } from './hooks.js';
export type { ReadyCondition } from './hooks.js';

// ---- observed state ---------------------------------------------------------
export { applyRuntimeEvent, createObservedStore, derivePodPhase, isPodReady } from './observed.js';

// ---- controllers and planner ------------------------------------------------
export {
  GENERATION_LABEL,
  OWNER_LABEL,
  expandDeployment,
  expandReplicaSet,
  runControllers,
  serviceEndpoints,
  serviceProxyPod,
} from './controllers.js';
export type { Endpoint } from './controllers.js';
export { formatAction, planAll, planPod } from './planner.js';
export type { Action } from './planner.js';

// ---- runtimes ---------------------------------------------------------------
export type {
  ContainerPatch,
  ContainerPhase,
  ObservedContainer,
  ObservedNetwork,
  ObservedPod,
  ObservedState,
  ObservedStore,
  PodPatch,
  PodPhase,
  Runtime,
  RuntimeContext,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeFactory,
  Unsubscribe,
} from './runtime/types.js';
export { createMemoryRuntime, memory } from './runtime/memory.js';
export type { MemoryRuntime, MemoryRuntimeOptions } from './runtime/memory.js';
export { containerd } from './runtime/containerd/index.js';

// ---- the control loop -------------------------------------------------------
export { DEFAULT_RESTART_POLICY, backoffDelay, serve } from './serve.js';
export type { RestartPolicy, ServeOptions, Served } from './serve.js';
