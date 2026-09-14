/**
 * react-reconciler hostConfig for fiber-servo.
 *
 * One rule governs this file:
 *
 *   **A commit produces a snapshot of what should exist, never a list of
 *   things to do.**
 *
 * So there are no ops here. The host methods do nothing but maintain a tree of
 * `Instance` nodes — append, insert, remove, re-read props — and
 * `resetAfterCommit` serialises that whole tree into a `DesiredState` and hands
 * it to the control plane. React's contribution is deciding *what the tree is*;
 * deciding what to do about it needs observed state, which React cannot see and
 * should not.
 *
 * That makes this file dramatically less clever than the op-emitting version it
 * replaces. There is no mount/unmount bookkeeping, no batch normalisation, no
 * rename handling: a resource that vanished from the tree is simply absent from
 * the next snapshot, and the reconciler downstream works out that it must go.
 * Re-serialising the tree on every commit is O(tree) where the old code was
 * O(changes), which at one machine's worth of containers is a trade worth
 * making many times over for the clarity.
 *
 * Host elements, and what nesting means for each:
 *
 *   network      a bridge network            (no children)
 *   pod          a sandbox                   (children: container)
 *   container    a process in a sandbox      (no children)
 *   replicaset   "keep N of this template"   (children: exactly one pod, unnamed)
 *   deployment   rollout policy over those   (children: exactly one pod, unnamed)
 *   service      a stable endpoint           (no children)
 *
 * Nesting is ownership and nothing else. A Pod's *network* is a `network="..."`
 * reference, never an ancestor, because a Network does not own the Pods on it.
 */
import type { HostConfig } from 'react-reconciler';
import { DiscreteEventPriority, NoEventPriority } from 'react-reconciler/constants.js';
import type {
  ContainerSpec,
  DeploymentSpec,
  DesiredState,
  NetworkSpec,
  PodSpec,
  PodTemplate,
  PortMapping,
  ReplicaSetSpec,
  Resource,
  ResourceLimits,
  RolloutStrategy,
  ServiceSpec,
} from './resources.js';

export type HostKind = 'network' | 'pod' | 'container' | 'replicaset' | 'deployment' | 'service';

const HOST_KINDS: readonly HostKind[] = [
  'network',
  'pod',
  'container',
  'replicaset',
  'deployment',
  'service',
];

// ---- props the host elements accept ----------------------------------------

export interface NetworkHostProps extends NetworkSpec {
  children?: unknown;
}

/** `name` is absent when the Pod is a ReplicaSet's or Deployment's template. */
export interface PodHostProps {
  name?: string;
  network?: string;
  labels?: Readonly<Record<string, string>>;
  publish?: readonly PortMapping[];
  children?: unknown;
}

export interface ContainerHostProps extends ContainerSpec {
  children?: unknown;
}

export interface ReplicaSetHostProps {
  name: string;
  replicas?: number;
  children?: unknown;
}

export interface DeploymentHostProps {
  name: string;
  replicas?: number;
  strategy?: RolloutStrategy;
  children?: unknown;
}

export interface ServiceHostProps extends ServiceSpec {
  children?: unknown;
}

export type HostProps = {
  network: NetworkHostProps;
  pod: PodHostProps;
  container: ContainerHostProps;
  replicaset: ReplicaSetHostProps;
  deployment: DeploymentHostProps;
  service: ServiceHostProps;
};

export type AnyHostProps = HostProps[HostKind];

/** A node of the tree React maintains for us. Deliberately dumb: props and children. */
export interface Instance {
  kind: HostKind;
  props: Record<string, unknown>;
  children: Instance[];
}

export interface RootContainer {
  kind: 'root';
  children: Instance[];
  /** Number of commits so far, including ones whose snapshot was unchanged. */
  commits: number;
  /** Receives the snapshot after every commit. */
  onCommit: (desired: DesiredState) => void;
}

type HostContext = Record<never, never>;

/** What `scheduleTimeout` hands back; see its comment. */
export interface TimeoutHandle {
  cancelled: boolean;
}

export function createRootContainer(onCommit: (desired: DesiredState) => void): RootContainer {
  return { kind: 'root', children: [], commits: 0, onCommit };
}

// ---- tree -> DesiredState ---------------------------------------------------

function fail(message: string): never {
  throw new Error(`fiber-servo: ${message}`);
}

function requireName(kind: HostKind, props: Record<string, unknown>): string {
  const name = props['name'];
  if (typeof name !== 'string' || name.length === 0) {
    fail(`<${kind}> requires a non-empty string "name"`);
  }
  return name;
}

/** Copies the listed props that were actually provided. Keeps `undefined` out of specs. */
function pick<T extends object>(props: Record<string, unknown>, keys: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (props[key] !== undefined) out[key] = props[key];
  return out as T;
}

function toContainer(instance: Instance): ContainerSpec {
  const name = requireName('container', instance.props);
  const image = instance.props['image'];
  if (typeof image !== 'string' || image.length === 0) {
    fail(`<container name="${name}"> requires a non-empty string "image"`);
  }
  if (instance.children.length > 0) {
    fail(`<container name="${name}"> takes no host children; a container has no sub-resources`);
  }
  return {
    ...pick<Omit<ContainerSpec, 'name' | 'image'>>(instance.props, [
      'command',
      'env',
      'ports',
      'resources',
      'readiness',
    ]),
    name,
    image,
  };
}

/** The sandbox half of a Pod: everything except its identity. */
function toPodTemplate(instance: Instance, owner: string): PodTemplate {
  const containers = instance.children.map((child) => {
    if (child.kind !== 'container') {
      fail(`<pod> in ${owner} may only contain <container>, got <${child.kind}>`);
    }
    return toContainer(child);
  });
  if (containers.length === 0) fail(`<pod> in ${owner} needs at least one <container>`);
  const seen = new Set<string>();
  for (const c of containers) {
    if (seen.has(c.name)) fail(`<pod> in ${owner} has two containers named "${c.name}"`);
    seen.add(c.name);
  }
  return {
    ...pick<Omit<PodTemplate, 'containers'>>(instance.props, ['network', 'labels', 'publish']),
    containers,
  };
}

function toPod(instance: Instance): PodSpec {
  const name = requireName('pod', instance.props);
  return { ...toPodTemplate(instance, `<pod name="${name}">`), name };
}

/** A ReplicaSet or Deployment owns exactly one unnamed `<pod>`: its template. */
function templateOf(instance: Instance, owner: string): PodTemplate {
  const pods = instance.children.filter((c) => c.kind === 'pod');
  if (instance.children.length !== pods.length) {
    fail(`${owner} may only contain a single <pod> template`);
  }
  const [pod, ...rest] = pods;
  if (pod === undefined) fail(`${owner} needs a <pod> template describing what to replicate`);
  if (rest.length > 0) {
    fail(`${owner} has ${pods.length} <pod> templates; it replicates exactly one`);
  }
  if (pod.props['name'] !== undefined) {
    fail(
      `${owner} has a <pod name="${String(pod.props['name'])}"> template: a replicated pod is named by its ` +
        'controller, so the template must not carry a name',
    );
  }
  return toPodTemplate(pod, owner);
}

function replicasOf(props: Record<string, unknown>, owner: string): number {
  const replicas = props['replicas'] ?? 1;
  if (typeof replicas !== 'number' || !Number.isInteger(replicas) || replicas < 0) {
    fail(`${owner} replicas must be a non-negative integer`);
  }
  return replicas;
}

function toResource(instance: Instance): Resource {
  switch (instance.kind) {
    case 'network': {
      const name = requireName('network', instance.props);
      const spec: NetworkSpec = { ...pick<Omit<NetworkSpec, 'name'>>(instance.props, ['subnet', 'labels']), name };
      return { kind: 'network', name, spec };
    }
    case 'pod': {
      const spec = toPod(instance);
      return { kind: 'pod', name: spec.name, spec };
    }
    case 'replicaset': {
      const name = requireName('replicaset', instance.props);
      const owner = `<replicaset name="${name}">`;
      const spec: ReplicaSetSpec = {
        name,
        replicas: replicasOf(instance.props, owner),
        template: templateOf(instance, owner),
      };
      return { kind: 'replicaset', name, spec };
    }
    case 'deployment': {
      const name = requireName('deployment', instance.props);
      const owner = `<deployment name="${name}">`;
      const spec: DeploymentSpec = {
        ...pick<Pick<DeploymentSpec, 'strategy'>>(instance.props, ['strategy']),
        name,
        replicas: replicasOf(instance.props, owner),
        template: templateOf(instance, owner),
      };
      return { kind: 'deployment', name, spec };
    }
    case 'service': {
      const name = requireName('service', instance.props);
      const port = instance.props['port'];
      const selector = instance.props['selector'];
      if (typeof port !== 'number') fail(`<service name="${name}"> requires a numeric "port"`);
      if (typeof selector !== 'object' || selector === null) {
        fail(`<service name="${name}"> requires a "selector" object matching pod labels`);
      }
      const spec: ServiceSpec = {
        ...pick<Omit<ServiceSpec, 'name' | 'port' | 'selector'>>(instance.props, [
          'network',
          'targetPort',
          'publish',
        ]),
        name,
        port,
        selector: selector as Readonly<Record<string, string>>,
      };
      return { kind: 'service', name, spec };
    }
    case 'container':
      return fail('<container> must be inside a <pod>');
  }
}

/**
 * Serialise the tree, parents before children, into the set of resources that
 * should exist. Containers do not appear at this level: they are part of the
 * Pod that owns them, which is what the Pod being a lifecycle boundary means.
 */
export function snapshot(root: RootContainer): DesiredState {
  const resources: Resource[] = [];
  const seen = new Set<string>();
  const walk = (nodes: readonly Instance[]): void => {
    for (const node of nodes) {
      const resource = toResource(node);
      const key = `${resource.kind}:${resource.name}`;
      if (seen.has(key)) fail(`duplicate ${resource.kind} name "${resource.name}"`);
      seen.add(key);
      resources.push(resource);
      // Pods, ReplicaSets and Deployments have already absorbed their children.
      if (node.kind === 'network' || node.kind === 'service') walk(node.children);
    }
  };
  walk(root.children);
  return { resources };
}

// ---- child-list plumbing ----------------------------------------------------

function detach(list: Instance[], child: Instance): void {
  const i = list.indexOf(child);
  if (i !== -1) list.splice(i, 1);
}

function insertAt(list: Instance[], child: Instance, before?: Instance): void {
  detach(list, child);
  const i = before ? list.indexOf(before) : -1;
  if (i === -1) list.push(child);
  else list.splice(i, 0, child);
}

let currentUpdatePriority: number = NoEventPriority;

// react-reconciler reads these as context objects to implement useFormStatus.
// We have no forms; the values only need to exist.
const NotPendingTransition = null;
const HostTransitionContext = {
  $$typeof: Symbol.for('react.context'),
  Provider: null,
  Consumer: null,
  _currentValue: NotPendingTransition,
  _currentValue2: NotPendingTransition,
  _threadCount: 0,
};

export const hostConfig = {
  // ---- capabilities -------------------------------------------------------
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsMicrotasks: true,
  supportsResources: false,
  supportsSingletons: false,
  supportsTestSelectors: false,
  isPrimaryRenderer: true,
  warnsIfNotActing: false,
  rendererPackageName: 'fiber-servo',
  rendererVersion: '0.0.1',
  extraDevToolsConfig: null,

  // ---- host context -------------------------------------------------------
  getRootHostContext(): HostContext {
    return {};
  },
  getChildHostContext(parent: HostContext): HostContext {
    return parent;
  },
  getPublicInstance(instance: Instance): Instance {
    return instance;
  },

  // ---- render phase -------------------------------------------------------
  createInstance(type: string, props: AnyHostProps): Instance {
    if (!(HOST_KINDS as readonly string[]).includes(type)) {
      fail(`unknown host element <${type}>. Valid elements are ${HOST_KINDS.join(', ')}.`);
    }
    return { kind: type as HostKind, props: props as unknown as Record<string, unknown>, children: [] };
  },
  createTextInstance(text: string): never {
    return fail(
      `text is not allowed in the tree (got ${JSON.stringify(text)}). ` +
        'Wrap runtime status in a component instead.',
    );
  },
  shouldSetTextContent(): boolean {
    return false;
  },
  appendInitialChild(parent: Instance, child: Instance): void {
    insertAt(parent.children, child);
  },
  finalizeInitialChildren(): boolean {
    return false;
  },

  // ---- commit phase -------------------------------------------------------
  prepareForCommit(): null {
    return null;
  },
  /**
   * The only place this renderer talks to the outside world, and it says one
   * thing: "here is everything that should exist". Every commit publishes,
   * even when the snapshot is identical to the last, because deciding that
   * nothing changed needs a comparison against observed state — and that is
   * the control loop's job, not React's.
   */
  resetAfterCommit(root: RootContainer): void {
    root.commits += 1;
    root.onCommit(snapshot(root));
  },
  clearContainer(root: RootContainer): void {
    root.children = [];
  },
  appendChild(parent: Instance, child: Instance): void {
    insertAt(parent.children, child);
  },
  appendChildToContainer(root: RootContainer, child: Instance): void {
    insertAt(root.children, child);
  },
  insertBefore(parent: Instance, child: Instance, before: Instance): void {
    insertAt(parent.children, child, before);
  },
  insertInContainerBefore(root: RootContainer, child: Instance, before: Instance): void {
    insertAt(root.children, child, before);
  },
  removeChild(parent: Instance, child: Instance): void {
    detach(parent.children, child);
  },
  removeChildFromContainer(root: RootContainer, child: Instance): void {
    detach(root.children, child);
  },
  commitUpdate(instance: Instance, _type: string, _prevProps: AnyHostProps, nextProps: AnyHostProps): void {
    instance.props = nextProps as unknown as Record<string, unknown>;
  },
  commitTextUpdate(): void {
    /* unreachable: createTextInstance throws */
  },
  commitMount(): void {},
  resetTextContent(): void {},
  hideInstance(): void {
    // A re-suspended subtree keeps its resources: `useReady` latches, so this
    // only happens for user-thrown promises, and stopping a Pod because a
    // sibling suspended would be a surprising policy to impose.
  },
  unhideInstance(): void {},
  hideTextInstance(): void {},
  unhideTextInstance(): void {},
  detachDeletedInstance(): void {},
  preparePortalMount(): void {},
  prepareScopeUpdate(): void {},
  getInstanceFromScope(): null {
    return null;
  },
  getInstanceFromNode(): null {
    return null;
  },

  // ---- scheduling ---------------------------------------------------------
  /**
   * React's only use of this in concurrent mode is to throttle the commit that
   * replaces a Suspense fallback (about 300ms, to avoid flashing UI). There is
   * no UI to flash: a Pod gated by <Ready> should be declared the moment its
   * dependency is up. So "later" means the next microtask, still cancellable.
   */
  scheduleTimeout(fn: () => void, _ms: number): TimeoutHandle {
    const handle: TimeoutHandle = { cancelled: false };
    queueMicrotask(() => {
      if (!handle.cancelled) fn();
    });
    return handle;
  },
  cancelTimeout(handle: TimeoutHandle): void {
    handle.cancelled = true;
  },
  noTimeout: -1 as const,
  scheduleMicrotask: queueMicrotask,
  getCurrentUpdatePriority(): number {
    return currentUpdatePriority;
  },
  setCurrentUpdatePriority(priority: number): void {
    currentUpdatePriority = priority;
  },
  resolveUpdatePriority(): number {
    // Every update outside an explicit priority is discrete, i.e. SyncLane. A
    // desired-state change has no "less urgent" variety, and sync lanes mean an
    // observed-state event re-renders and commits on the next microtask with no
    // Scheduler involvement. Suspense retries are the exception: React picks a
    // retry lane and goes through the Scheduler.
    return currentUpdatePriority !== NoEventPriority ? currentUpdatePriority : DiscreteEventPriority;
  },
  shouldAttemptEagerTransition(): boolean {
    return false;
  },
  trackSchedulerEvent(): void {},
  resolveEventType(): null {
    return null;
  },
  resolveEventTimeStamp(): number {
    return -1.1;
  },
  requestPostPaintCallback(): void {},

  // ---- suspending commits (unused) ----------------------------------------
  maySuspendCommit(): boolean {
    return false;
  },
  maySuspendCommitOnUpdate(): boolean {
    return false;
  },
  maySuspendCommitInSyncRender(): boolean {
    return false;
  },
  preloadInstance(): boolean {
    return true;
  },
  startSuspendingCommit(): void {},
  suspendInstance(): void {},
  suspendOnActiveViewTransition(): void {},
  waitForCommitToBeReady(): null {
    return null;
  },
  getSuspendedCommitReason(): null {
    return null;
  },

  // ---- forms / transitions (unused) ---------------------------------------
  NotPendingTransition,
  HostTransitionContext,
  resetFormInstance(): void {},
  bindToConsole(method: 'log' | 'warn' | 'error', args: unknown[]): () => void {
    return console[method].bind(console, ...args);
  },
};

/**
 * @types/react-reconciler lags the runtime (0.33 types vs 0.34 runtime), so the
 * config is authored as a plain object and cast once, here.
 */
export const typedHostConfig = hostConfig as unknown as HostConfig<
  HostKind,
  AnyHostProps,
  RootContainer,
  Instance,
  never,
  never,
  never,
  Instance,
  HostContext,
  null,
  never,
  TimeoutHandle,
  -1,
  null
>;

export type { ResourceLimits };
