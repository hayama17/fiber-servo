/**
 * The user-facing API: six components, each a thin wrapper over one host
 * element, plus `<Ready>` for ordering.
 *
 * They are thin on purpose. A component here decides nothing about the
 * runtime — it declares a resource and stops. The interesting behaviour
 * (how many Pods there should be, which of them are up, what to do about the
 * difference) lives in the controllers, where it can see observed state.
 *
 * Two shapes to learn, and they are the whole mental model:
 *
 *   nesting is ownership     <ReplicaSet> owns a <Pod> template,
 *                            a <Pod> owns its <Container>s
 *
 *   props are references     a Pod joins a Network by name,
 *                            a Service selects Pods by label
 *
 * So this is right:
 *
 *   <Network name="backend" />
 *   <ReplicaSet name="api" replicas={3}>
 *     <Pod network="backend" labels={{ app: 'api' }}>
 *       <Container name="app" image="api:v1" />
 *     </Pod>
 *   </ReplicaSet>
 *
 * and wrapping the ReplicaSet in the <Network> would not be, because a Network
 * does not own the Pods that attach to it.
 */
import { Suspense, createElement, type ReactElement, type ReactNode } from 'react';
import type {
  ContainerSpec,
  DeploymentSpec,
  NetworkSpec,
  PodTemplate,
  PortMapping,
  ReplicaSetSpec,
  ServiceSpec,
} from './resources.js';
import { useReady, type ReadyCondition } from './hooks.js';

/** The host elements. Typed here once so callers never touch string types. */
function host<P extends object>(type: string, props: P): ReactElement {
  return createElement(type as never, props);
}

// ---- Network ---------------------------------------------------------------

export interface NetworkProps extends NetworkSpec {
  /** Networks own nothing. Pods join by `network="name"`. */
  children?: never;
}

/**
 * A local bridge network, roughly a Docker user-defined network. Pods on the
 * same Network reach each other. Everything but the name is fixed once it
 * exists, so changing the subnet replaces the Network.
 */
export function Network(props: NetworkProps): ReactElement {
  const { children: _children, ...spec } = props;
  return host('network', spec);
}

// ---- Container -------------------------------------------------------------

export interface ContainerProps extends ContainerSpec {
  /** Containers own nothing. Ordering between Pods is `<Ready>`. */
  children?: never;
}

/**
 * One process and one root filesystem inside a Pod's sandbox. Only valid as a
 * child of `<Pod>`: a container has no network or lifecycle of its own, it
 * borrows the sandbox's.
 *
 * Everything here except `resources` is immutable — change an image or a
 * command and the container is replaced, not edited.
 */
export function Container(props: ContainerProps): ReactElement {
  const { children: _children, ...spec } = props;
  return host('container', spec);
}

// ---- Pod -------------------------------------------------------------------

export interface PodProps extends Omit<PodTemplate, 'containers'> {
  /**
   * Runtime identity. Required at the top level; omitted when the Pod is a
   * `<ReplicaSet>`'s or `<Deployment>`'s template, because those name the
   * copies they create.
   */
  name?: string;
  /** One or more `<Container>`s. */
  children: ReactNode;
}

/**
 * An execution sandbox: a network namespace and shared volumes, with one or
 * more containers inside it. The Pod is the unit everything else counts and
 * routes to — a ReplicaSet keeps N Pods, a Service load-balances across Pods.
 *
 * Pod-level props define the sandbox, so all of them are immutable: changing
 * `network` replaces the Pod rather than moving it.
 */
export function Pod({ children, ...spec }: PodProps): ReactElement {
  return host('pod', { ...spec, children });
}

// ---- ReplicaSet ------------------------------------------------------------

export interface ReplicaSetProps extends Omit<ReplicaSetSpec, 'template' | 'replicas'> {
  replicas?: number;
  /** Exactly one unnamed `<Pod>`: the template to stamp out. */
  children: ReactNode;
}

/**
 * "Keep `replicas` Pods of this template alive."
 *
 * This is the component that makes the project's central claim concrete. It
 * declares a *count*, not identities, so when a Pod dies nothing here changes
 * and React does not re-render: the ReplicaSet controller compares desired 3
 * against observed 2 and creates one. The JSX is the same either way.
 */
export function ReplicaSet({ children, ...spec }: ReplicaSetProps): ReactElement {
  return host('replicaset', { ...spec, children });
}

// ---- Deployment ------------------------------------------------------------

export interface DeploymentProps extends Omit<DeploymentSpec, 'template' | 'replicas'> {
  replicas?: number;
  /** Exactly one unnamed `<Pod>`: the template to roll out. */
  children: ReactNode;
}

/**
 * A rollout policy over ReplicaSets. Editing the template does not edit the
 * running Pods: it names a new generation, and the Deployment controller moves
 * replicas from the old ReplicaSet to the new one within `strategy`'s bounds.
 */
export function Deployment({ children, ...spec }: DeploymentProps): ReactElement {
  return host('deployment', { ...spec, children });
}

// ---- Service ---------------------------------------------------------------

export interface ServiceProps extends ServiceSpec {
  /** Services own nothing; they select Pods by label. */
  children?: never;
}

/**
 * One stable address in front of whichever Pods currently match `selector`.
 *
 * Note what is *not* a prop: the list of backends. Pods matching the selector
 * come and go without the tree changing, so the backend set is resolved from
 * observed state by the Service controller. This is also the answer to "why
 * not just publish a host port on the Pod" — three replicas cannot each own
 * host port 8080, but one Service in front of them can.
 */
export function Service(props: ServiceProps): ReactElement {
  const { children: _children, ...spec } = props;
  return host('service', spec);
}

// ---- ordering --------------------------------------------------------------

export interface ReadyProps {
  /** Pod name(s) that must be up before `children` are declared. */
  on: string | readonly string[];
  /** `running` (default), or `ready` once every readiness probe has passed. */
  until?: ReadyCondition;
  children?: ReactNode;
}

function Gate({ on, until = 'running', children }: ReadyProps): ReactNode {
  useReady(on, until);
  return children;
}

/**
 * Dependency ordering. Nothing inside is declared until every Pod in `on` has
 * satisfied `until` once — so a migration Pod can wait for its database.
 *
 * This is the one place the tree reads observed state, and it reads it to
 * decide what to *want*, which is legitimate. It latches: a dependency that
 * later dies does not retract what already depends on it.
 */
export function Ready({ on, until, children }: ReadyProps): ReactElement {
  return createElement(Suspense, { fallback: null }, createElement(Gate, { on, until }, children));
}

export type { PortMapping, ReadyCondition };
