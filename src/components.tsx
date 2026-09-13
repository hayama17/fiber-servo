/**
 * User-facing components. Everything here is a plain function component that
 * eventually renders one of the two host elements, `container` or `network`.
 * Composition (Deployment today, WebApp tomorrow) is just functions
 * returning elements.
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
import { NetworkContext, type RestartMode, useNetwork, useReady, useSelfHeal } from './hooks.js';
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
  const { name, restart = 'always', ...rest } = props;
  const enclosing = useNetwork();
  if (name === undefined) {
    throw new Error('react4c: <Container> needs a "name", or a parent that assigns one (e.g. <Deployment>)');
  }
  const spec = { name, ...rest, network: rest.network ?? enclosing };
  return container({ ...spec, restarts: useSelfHeal(name, restart) });
}

export interface DeploymentProps {
  name: string;
  replicas?: number;
  /** One or more <Container> templates; each is stamped out `replicas` times. */
  children: ReactNode;
}

/**
 * Expands its container templates into `replicas` keyed copies named
 * `${name}-${index}` (or `${name}-${childName}-${index}` for named templates).
 *
 * Keys are the replica index, so scaling 3 -> 5 leaves 0..2 untouched and
 * only mounts 3 and 4; the reconciler emits exactly two CREATE ops.
 */
export function Deployment({ name, replicas = 1, children }: DeploymentProps): ReactElement {
  if (!Number.isInteger(replicas) || replicas < 0) {
    throw new Error(`react4c: <Deployment name="${name}"> replicas must be a non-negative integer`);
  }
  const templates = Children.toArray(children).filter((c): c is ReactElement<ContainerProps> =>
    isValidElement<ContainerProps>(c),
  );
  const copies: ReactElement[] = [];
  for (let i = 0; i < replicas; i++) {
    for (const template of templates) {
      const base = template.props.name ? `${name}-${template.props.name}` : name;
      const id = `${base}-${i}`;
      copies.push(cloneElement(template, { key: id, name: id }));
    }
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
  /** Container name(s) that must have been reported `running` before `children` mount. */
  on: string | readonly string[];
  children?: ReactNode;
}

function Gate({ on, children }: ReadyProps): ReactNode {
  useReady(on);
  return children;
}

/**
 * Dependency ordering. Nothing inside mounts (no CREATE is emitted) until
 * every container in `on` has run once. Sugar for a <Suspense> boundary
 * around a component that calls `useReady`.
 */
export function Ready({ on, children }: ReadyProps): ReactElement {
  return createElement(Suspense, { fallback: null }, createElement(Gate, { on }, children));
}
