/**
 * User-facing components. Everything here is a plain function component that
 * eventually renders the single host element, `container`. Composition
 * (Deployment today, WebApp tomorrow) is just functions returning elements.
 */
import {
  Children,
  Fragment,
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { ContainerHostProps } from './hostConfig.js';
import type { ContainerSpec } from './ops.js';

export interface ContainerProps extends Omit<ContainerSpec, 'name'> {
  /**
   * Runtime identity. Required when used directly; a parent such as
   * <Deployment> fills it in for replicas.
   */
  name?: string;
  children?: ReactNode;
}

/** The host element. Typed here once so callers never touch string types. */
function container(props: ContainerHostProps): ReactElement {
  return createElement('container' as never, props);
}

export function Container(props: ContainerProps): ReactElement {
  const { name, ...rest } = props;
  if (name === undefined) {
    throw new Error('react4c: <Container> needs a "name", or a parent that assigns one (e.g. <Deployment>)');
  }
  return container({ name, ...rest });
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
