/**
 * User-facing components. Everything here is a plain function component that
 * eventually renders one of the two host elements, `container` or `network`.
 * Composition (Deployment, Service, your own <WebApp/>) is just functions
 * returning elements.
 *
 * The tree shape carries meaning:
 *   - inside a <Network>: membership
 *   - inside a <Container>: dependency; children mount once the container is up
 */
import {
  Children,
  Fragment,
  Suspense,
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { ContainerHostProps, NetworkHostProps } from './hostConfig.js';
import {
  NetworkContext,
  type ReadyCondition,
  type RestartMode,
  useNetwork,
  useReady,
  useSelfHeal,
} from './hooks.js';
import type { ContainerSpec, NetworkSpec } from './ops.js';

export interface ContainerProps extends Omit<ContainerSpec, 'name'> {
  /**
   * Runtime identity. Required when used directly; a parent such as
   * <Deployment> fills it in for replicas.
   */
  name?: string;
  /**
   * What to do when the status store reports the container dead.
   * `'always'` (default) restarts with exponential backoff, `'never'` leaves
   * it, an object tunes the backoff. See `RestartPolicy`.
   */
  restart?: RestartMode;
  /**
   * Dependents. They mount only once this container is running, or ready
   * when it has a `readiness` probe, and unmount before it.
   */
  children?: ReactNode;
}

/** The host elements. Typed here once so callers never touch string types. */
function container(props: ContainerHostProps): ReactElement {
  return createElement('container' as never, props);
}
function network(props: NetworkHostProps): ReactElement {
  return createElement('network' as never, props);
}

export function Container(props: ContainerProps): ReactElement {
  const { name, restart = 'always', children, ...rest } = props;
  const enclosing = useNetwork();
  if (name === undefined) {
    throw new Error(
      'fiber-servo: <Container> needs a "name", or a parent that assigns one (e.g. <Deployment>)',
    );
  }
  const spec = { name, ...rest, network: rest.network ?? enclosing };
  const host = container({ ...spec, restarts: useSelfHeal(name, restart) });
  if (children === undefined || children === null || children === false) return host;
  // Dependents come first in tree order so React deletes them before the
  // container on unmount; on mount the gate holds them back anyway.
  return createElement(
    Fragment,
    null,
    createElement(Ready, { on: name, until: spec.readiness ? 'ready' : 'running' }, children),
    host,
  );
}

export interface ServiceOptions {
  /** Port the service listens on inside the network. */
  port: number;
  /** Port on the targets. Default: `port`. */
  targetPort?: number;
  /** Host port to bind, if the service should be reachable from outside. */
  publish?: number;
  /** Service name. Default: the deployment's name. */
  name?: string;
  /** Which template's replicas to target when the deployment has named templates. */
  target?: string;
}

export interface DeploymentProps {
  name: string;
  replicas?: number;
  /** One or more <Container> templates; each is stamped out `replicas` times. */
  children: ReactNode;
  /** Also render a <Service> in front of the replicas. */
  service?: ServiceOptions;
}

/**
 * Expands its container templates into `replicas` keyed copies named
 * `${name}-${index}` (or `${name}-${childName}-${index}` for named templates).
 *
 * Keys are the replica index, so scaling 3 -> 5 leaves 0..2 untouched and
 * only mounts 3 and 4; the reconciler emits exactly two CREATE ops.
 *
 * Dependents nested inside a template are cloned per replica too; give them
 * per-replica names or place them next to the deployment instead.
 */
export function Deployment({ name, replicas = 1, children, service }: DeploymentProps): ReactElement {
  if (!Number.isInteger(replicas) || replicas < 0) {
    throw new Error(`fiber-servo: <Deployment name="${name}"> replicas must be a non-negative integer`);
  }
  const templates = Children.toArray(children).filter((c): c is ReactElement<ContainerProps> =>
    isValidElement<ContainerProps>(c),
  );
  const copies: ReactElement[] = [];
  const targets: string[] = [];
  for (let i = 0; i < replicas; i++) {
    for (const template of templates) {
      const templateName = template.props.name;
      const base = templateName ? `${name}-${templateName}` : name;
      const id = `${base}-${i}`;
      copies.push(cloneElement(template, { key: id, name: id }));
      if (service && (service.target ?? undefined) === templateName) targets.push(id);
    }
  }
  if (service) {
    if (targets.length === 0 && replicas > 0) {
      throw new Error(
        `fiber-servo: <Deployment name="${name}"> service has no targets; name the template with service.target`,
      );
    }
    copies.push(
      createElement(Service, {
        key: `${name}:service`,
        name: service.name ?? name,
        port: service.port,
        targetPort: service.targetPort,
        publish: service.publish,
        targets,
      }),
    );
  }
  return createElement(Fragment, null, ...copies);
}

export interface NetworkProps extends NetworkSpec {
  children?: ReactNode;
}

/**
 * A user-defined network. Containers rendered inside attach to it (unless
 * they name another `network` explicitly) and resolve each other by name.
 * Being a host element, it is created before its containers and deleted
 * after them.
 */
export function Network({ children, ...spec }: NetworkProps): ReactElement {
  return network({ ...spec, children: createElement(NetworkContext, { value: spec.name }, children) });
}

export interface ReadyProps {
  /** Container name(s) that must be up before `children` mount. */
  on: string | readonly string[];
  /** `running` (default) or `ready` (the container's readiness probe has passed). */
  until?: ReadyCondition;
  children?: ReactNode;
}

function Gate({ on, until = 'running', children }: ReadyProps): ReactNode {
  useReady(on, until);
  return children;
}

/**
 * Dependency ordering. Nothing inside mounts (no CREATE is emitted) until
 * every container in `on` has satisfied `until` once. Sugar for a
 * <Suspense> boundary around a component that calls `useReady`. Nesting
 * inside <Container> does the same for a single dependency.
 */
export function Ready({ on, until, children }: ReadyProps): ReactElement {
  return createElement(Suspense, { fallback: null }, createElement(Gate, { on, until }, children));
}

export const DEFAULT_PROXY_IMAGE = 'docker.io/library/caddy:2-alpine';

export interface ServiceProps {
  name: string;
  /** Port the service listens on inside the network. */
  port: number;
  /** Port on the targets. Default: `port`. */
  targetPort?: number;
  /** Host port to bind, if the service should be reachable from outside. */
  publish?: number;
  /** Container names to balance across. */
  targets: readonly string[];
  /** Proxy image. Must ship the `caddy` binary. */
  image?: string;
  restart?: RestartMode;
}

/**
 * One name in front of many containers: a caddy reverse proxy that
 * round-robins across `targets`. Built entirely by composition, so scaling
 * the targets is an UPDATE of the proxy's command.
 */
export function Service({
  name,
  port,
  targetPort = port,
  publish,
  targets,
  image = DEFAULT_PROXY_IMAGE,
  restart,
}: ServiceProps): ReactElement | null {
  if (targets.length === 0) return null;
  const command = [
    'caddy',
    'reverse-proxy',
    '--from',
    `:${port}`,
    ...targets.flatMap((t) => ['--to', `${t}:${targetPort}`]),
  ];
  return createElement(Container, {
    name,
    image,
    command,
    ports: [port],
    publish: publish === undefined ? undefined : [{ host: publish, container: port }],
    restart,
  });
}
