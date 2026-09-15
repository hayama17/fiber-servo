/**
 * Public API, grouped the way the architecture is layered.
 *
 *   components    what you write        JSX -> desired state
 *   resources     the vocabulary        the specs every layer speaks
 *   controllers   management -> runtime Deployment -> ReplicaSet -> Container
 *   compose       the write-path model  desired containers -> a Compose Application Model
 *   planner       desired vs observed   what applying the model would change (informational)
 *   runtime       the adapter           the only layer that knows how
 *   serve         the control loop      ties the two reconciliations together
 */

// ---- what you write --------------------------------------------------------
export { Container, Deployment, Network, Ready, ReplicaSet, Service } from './components.js';
export type {
  ContainerProps,
  DeploymentProps,
  NetworkProps,
  ReadyProps,
  ReplicaSetProps,
  ServiceProps,
} from './components.js';

// ---- the vocabulary --------------------------------------------------------
export {
  RESOURCE_KINDS,
  SHORT_DIGEST_LENGTH,
  digest,
  resourcesOfKind,
  selectorMatches,
  shortDigest,
  specValueEquals,
} from './resources.js';
export type {
  ContainerSpec,
  ContainerTemplate,
  DeploymentSpec,
  DesiredState,
  NetworkSpec,
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
export { containerSatisfies, readyThenable, useContainer, useObserved, useReady } from './hooks.js';
export type { ReadyCondition } from './hooks.js';

// ---- generation history -----------------------------------------------------
export { createGenerationHistory } from './generations.js';
export type { GenerationHistory, Generations } from './generations.js';

// ---- observed state ---------------------------------------------------------
export { applyRuntimeEvent, createObservedStore, isReady } from './observed.js';

// ---- controllers and planner ------------------------------------------------
export {
  GENERATION_LABEL,
  OWNER_LABEL,
  expandDeployment,
  expandReplicaSet,
  runControllers,
  serviceEndpoints,
  serviceProxyContainer,
} from './controllers.js';
export type { Endpoint } from './controllers.js';
export { formatPlan, planApply, planIsEmpty } from './planner.js';
export type { Plan } from './planner.js';

// ---- the write-path model ---------------------------------------------------
export {
  DEFAULT_PROJECT,
  MANAGED_LABEL,
  READINESS_LABEL,
  SPEC_LABEL,
  changedServices,
  decodeReadiness,
  encodeReadiness,
  orphanedServices,
  renderCompose,
  toComposeApplication,
  toComposeService,
} from './compose.js';
export type { ComposeApplication, ComposeNetwork, ComposeService } from './compose.js';

// ---- runtimes ---------------------------------------------------------------
export type {
  ContainerPatch,
  ContainerPhase,
  ObservedContainer,
  ObservedState,
  ObservedStore,
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
