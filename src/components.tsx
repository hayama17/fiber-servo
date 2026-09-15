/**
 * The user-facing API: resource declarations plus React controller components.
 *
 * Controllers read the shared observed store and render runtime resources.
 * Host elements remain declarative and perform no I/O.
 *
 * Two shapes to learn, and they are the whole mental model:
 *
 *   nesting is ownership     <ReplicaSet> owns a <Container> template
 *
 *   props are references     a Container joins a Network by name,
 *                            a Service selects Containers by label
 *
 * So this is right:
 *
 *   <Network name="backend" />
 *   <ReplicaSet name="api" replicas={3}>
 *     <Container image="api:v1" network="backend" labels={{ app: 'api' }} />
 *   </ReplicaSet>
 *
 * and wrapping the ReplicaSet in the <Network> would not be, because a
 * Network does not own the Containers that attach to it.
 *
 * There is no `<Pod>`. An earlier design had one — a sandbox owning one or
 * more Containers, sharing its network namespace — and it existed only to
 * buy sidecars. That is gone: a Container is the unit of everything, a
 * ReplicaSet counts Containers directly, a Service routes to Containers
 * directly, and one Container becomes exactly one Compose service.
 */
import {
  Children,
  Fragment,
  Suspense,
  createElement,
  isValidElement,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import type {
  ContainerSpec,
  DeploymentSpec,
  NetworkSpec,
  PortMapping,
  ReplicaSetSpec,
  ServiceSpec,
} from './resources.js';
import { digest } from './resources.js';
import { useObserved, useReady, type ReadyCondition } from './hooks.js';
import {
  expandDeployment,
  expandReplicaSet,
  GENERATION_LABEL,
  OWNER_LABEL,
  serviceEndpoints,
  serviceProxyContainer,
} from './controllers.js';
import { createGenerationHistory, type GenerationHistory } from './generations.js';

/** The host elements. Typed here once so callers never touch string types. */
function host<P extends object>(type: string, props: P): ReactElement {
  return createElement(type as never, props);
}

// ---- Network ---------------------------------------------------------------

export interface NetworkProps extends NetworkSpec {
  /** Networks own nothing. Containers join by `network="name"`. */
  children?: never;
}

/**
 * A local bridge network, roughly a Docker user-defined network. Containers
 * on the same Network reach each other by name. Everything but the name is
 * fixed once it exists, so changing the subnet replaces the Network.
 */
export function Network(props: NetworkProps): ReactElement {
  const { children: _children, ...spec } = props;
  return host('network', spec);
}

// ---- Container ---------------------------------------------------------------

export interface ContainerProps extends Omit<ContainerSpec, 'name'> {
  /**
   * Required at the top level; omitted when the Container is a
   * `<ReplicaSet>`'s or `<Deployment>`'s template, because those name the
   * copies they create. Optional here rather than a discriminated union so
   * both uses share one component; `hostConfig.ts` enforces which is
   * required, at render time, for whichever position this element is in.
   */
  name?: string;
  /** Containers own nothing. Ordering between them is `<Ready>`. */
  children?: never;
}

/**
 * The unit of everything: one process, one image, one Compose service. A
 * `<Container>` used directly (as opposed to as a `<ReplicaSet>`'s or
 * `<Deployment>`'s template child) needs a `name` — its runtime identity.
 *
 * Everything here except `resources` is immutable in spirit, but note what
 * that means under the Compose write path: there is no live-update
 * primitive fiber-servo can reach without stepping outside Compose, so in
 * practice *every* field change — `resources` included — replaces the
 * container rather than editing it in place. See `planner.ts` for where
 * this is decided (nowhere above the runtime boundary, any more).
 */
export function Container(props: ContainerProps): ReactElement {
  const { children: _children, ...spec } = props;
  return host('container', spec);
}

// ---- ReplicaSet ------------------------------------------------------------

export interface ReplicaSetProps extends Omit<ReplicaSetSpec, 'template' | 'replicas'> {
  replicas?: number;
  /** Exactly one unnamed `<Container>`: the template to stamp out. */
  children: ReactNode;
}

/**
 * "Keep `replicas` Containers of this template alive."
 *
 * ReplicaSet is a controller component: it subscribes to observed state and
 * renders the runtime Containers that should exist. A runtime event therefore
 * flows through React and produces a new commit when the set changes.
 */
export function ReplicaSet({ children, replicas = 1, ...spec }: ReplicaSetProps): ReactElement {
  const store = useObserved();
  const observed = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const child = Children.only(children);
  if (!isValidElement<ContainerProps>(child) || child.type !== Container) {
    throw new Error('fiber-servo: ReplicaSet needs exactly one <Container> template');
  }
  const template = { ...child.props };
  delete template.name;
  const containers = expandReplicaSet({ name: spec.name, replicas, template }, observed);
  return createElement(
    Fragment,
    null,
    containers.map((container) => createElement(Container, { ...container, key: container.name })),
  ) as unknown as ReactElement;
}

// ---- Deployment ------------------------------------------------------------

export interface DeploymentProps extends Omit<DeploymentSpec, 'template' | 'replicas'> {
  replicas?: number;
  /** Exactly one unnamed `<Container>`: the template to roll out. */
  children: ReactNode;
}

/**
 * A rollout policy over ReplicaSets. Editing the template does not edit the
 * running Containers: it names a new generation, and the Deployment
 * controller moves replicas from the old ReplicaSet to the new one within
 * `strategy`'s bounds.
 */
export function Deployment({ children, ...spec }: DeploymentProps): ReactElement {
  const store = useObserved();
  const observed = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const historyRef = useRef<GenerationHistory | undefined>(undefined);
  if (!historyRef.current) historyRef.current = createGenerationHistory();
  const child = Children.only(children);
  if (!isValidElement<ContainerProps>(child) || child.type !== Container) {
    throw new Error('fiber-servo: Deployment needs exactly one <Container> template');
  }
  const template = { ...child.props };
  delete template.name;
  const deployment = {
    ...spec,
    replicas: spec.replicas ?? 1,
    template,
  };
  historyRef.current.remember(template);
  const containers = expandDeployment(deployment, observed, historyRef.current.all()).flatMap((replicaSet) =>
    expandReplicaSet(replicaSet, observed).map((container) => ({
      ...container,
      labels: {
        ...container.labels,
        [OWNER_LABEL]: spec.name,
        [GENERATION_LABEL]: digest(replicaSet.template),
      },
    })),
  );
  return createElement(
    Fragment,
    null,
    containers.map((container) => createElement(Container, { ...container, key: container.name })),
  ) as unknown as ReactElement;
}

// ---- Service ---------------------------------------------------------------

export interface ServiceProps extends ServiceSpec {
  /** Services own nothing; they select Containers by label. */
  children?: never;
}

/**
 * One stable address in front of whichever Containers currently match
 * `selector`.
 *
 * Note what is *not* a prop: the list of backends. Containers matching the
 * selector come and go without the tree changing, so the backend set is
 * resolved from observed state by the Service controller. This is also the
 * answer to "why not just publish a host port on the Container" — three
 * replicas cannot each own host port 8080, but one Service in front of them
 * can.
 */
export function Service(props: ServiceProps): ReactElement {
  const store = useObserved();
  const observed = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const { children: _children, ...spec } = props;
  const proxy = serviceProxyContainer(spec, serviceEndpoints(spec, observed));
  return proxy ? createElement(Container, proxy) : createElement(Fragment, null);
}

// ---- ordering --------------------------------------------------------------

export interface ReadyProps {
  /** Container name(s) that must be up before `children` are declared. */
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
 * Dependency ordering. Nothing inside is declared until every Container in
 * `on` has satisfied `until` once — so a migration container can wait for
 * its database.
 *
 * This is the one place the tree reads observed state, and it reads it to
 * decide what to *want*, which is legitimate. It latches: a dependency that
 * later dies does not retract what already depends on it.
 */
export function Ready({ on, until, children }: ReadyProps): ReactElement {
  return createElement(Suspense, { fallback: null }, createElement(Gate, { on, until }, children));
}

export type { PortMapping, ReadyCondition };
