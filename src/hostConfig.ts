/**
 * react-reconciler hostConfig for fiber-servo.
 *
 * Two rules are fixed here and everything else is built on top of them:
 *
 *   1. spec = fiber tree. Host instances *are* the desired state. Runtime
 *      status (is the container alive?) lives outside the tree and is read
 *      with useSyncExternalStore.
 *   2. commit executes nothing. Every host method is synchronous and only
 *      appends to `root.pending`. `resetAfterCommit` hands the batch to the
 *      sink; the sink is the only place a side effect may happen.
 *
 * Host elements: `container` and `network`. Nesting gives ordering: a
 * network is created before the containers inside it and deleted after.
 */
import type { HostConfig } from 'react-reconciler';
import { DiscreteEventPriority, NoEventPriority } from 'react-reconciler/constants.js';
import {
  SPEC_KEYS,
  diffSpec,
  type ContainerSpec,
  type InstanceKind,
  type NetworkSpec,
  type Op,
  type OpSink,
  type Specs,
} from './ops.js';

export type HostType = InstanceKind;

/** Props accepted by the `container` host element. */
export interface ContainerHostProps extends ContainerSpec {
  /**
   * Desired restart generation. Not part of the spec sent with CREATE; each
   * increment after mount becomes one START op. Written by <Container>'s
   * self-healing logic from what it reads in the status store.
   */
  restarts?: number;
  children?: unknown;
}

export interface NetworkHostProps extends NetworkSpec {
  children?: unknown;
}

export type HostProps = { container: ContainerHostProps; network: NetworkHostProps };

export type Instance = {
  [K in InstanceKind]: {
    kind: K;
    /** Identity as seen by the runtime. Equal to `spec.name`. */
    id: string;
    spec: Specs[K];
    /** Last restart generation turned into an op (containers only). */
    restarts: number;
    children: Instance[];
    root: RootContainer;
    /** True between the CREATE and DELETE ops for this instance. */
    created: boolean;
  };
}[InstanceKind];

export interface RootContainer {
  kind: 'root';
  children: Instance[];
  /** Ops of the commit in flight. Flushed to `sink` in `resetAfterCommit`. */
  pending: Op[];
  /** Instances that currently have an outstanding CREATE, keyed by `kind:id`. */
  live: Map<string, Instance>;
  /** Number of commits so far, including ones that produced no ops. */
  commits: number;
  sink: OpSink;
}

type HostContext = Record<never, never>;

/** What `scheduleTimeout` hands back; see its comment. */
export interface TimeoutHandle {
  cancelled: boolean;
}

export function createRootContainer(sink: OpSink): RootContainer {
  return { kind: 'root', children: [], pending: [], live: new Map(), commits: 0, sink };
}

export const liveKey = (kind: InstanceKind, id: string): string => `${kind}:${id}`;

function isKind(type: string): type is InstanceKind {
  return type in SPEC_KEYS;
}

function propsToSpec<K extends InstanceKind>(kind: K, props: HostProps[K]): Specs[K] {
  const p = props as unknown as Record<string, unknown>;
  if (typeof p['name'] !== 'string' || p['name'].length === 0) {
    throw new Error(`fiber-servo: <${kind}> requires a non-empty string "name"`);
  }
  if (kind === 'container' && (typeof p['image'] !== 'string' || p['image'].length === 0)) {
    throw new Error(`fiber-servo: <container name="${p['name']}"> requires a non-empty string "image"`);
  }
  const spec: Record<string, unknown> = {};
  for (const key of SPEC_KEYS[kind] as readonly string[]) {
    if (p[key] !== undefined) spec[key] = p[key];
  }
  return spec as unknown as Specs[K];
}

function push(root: RootContainer, op: Op): void {
  root.pending.push(op);
}

function createOp(instance: Instance): Op {
  return instance.kind === 'container'
    ? { type: 'CREATE', kind: 'container', id: instance.id, spec: instance.spec }
    : { type: 'CREATE', kind: 'network', id: instance.id, spec: instance.spec };
}

/** Emit CREATE for every not-yet-created instance in the subtree, parents first. */
function mountSubtree(instance: Instance): void {
  const root = instance.root;
  if (!instance.created) {
    const key = liveKey(instance.kind, instance.id);
    if (root.live.has(key)) {
      throw new Error(`fiber-servo: duplicate ${instance.kind} name "${instance.id}"`);
    }
    instance.created = true;
    root.live.set(key, instance);
    push(root, createOp(instance));
  }
  for (const child of instance.children) mountSubtree(child);
}

/**
 * Emit DELETE for the whole subtree: children in tree order, then the parent.
 * Tree order matters because <Container> renders its dependents ahead of
 * itself, so a later-inserted dependent still goes before what it depends on.
 */
function unmountSubtree(instance: Instance): void {
  for (const child of instance.children) unmountSubtree(child);
  if (instance.created) {
    instance.created = false;
    instance.root.live.delete(liveKey(instance.kind, instance.id));
    push(instance.root, { type: 'DELETE', kind: instance.kind, id: instance.id });
  }
}

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

  // ---- render phase (no ops here) ----------------------------------------
  createInstance(type: string, props: HostProps[InstanceKind], root: RootContainer): Instance {
    if (!isKind(type)) {
      throw new Error(
        `fiber-servo: unknown host element <${type}>. Only <container> and <network> are supported.`,
      );
    }
    const base = { children: [], root, created: false };
    if (type === 'container') {
      const p = props as ContainerHostProps;
      const spec = propsToSpec('container', p);
      return { kind: 'container', id: spec.name, spec, restarts: p.restarts ?? 0, ...base };
    }
    const spec = propsToSpec('network', props as NetworkHostProps);
    return { kind: 'network', id: spec.name, spec, restarts: 0, ...base };
  },
  createTextInstance(text: string): never {
    throw new Error(
      `fiber-servo: text is not allowed in the tree (got ${JSON.stringify(text)}). ` +
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

  // ---- commit phase (ops only, never execution) --------------------------
  prepareForCommit(): null {
    return null;
  },
  resetAfterCommit(root: RootContainer): void {
    root.commits += 1;
    if (root.pending.length === 0) return;
    const batch = root.pending;
    root.pending = [];
    root.sink(batch);
  },
  clearContainer(root: RootContainer): void {
    for (const child of root.children) unmountSubtree(child);
    root.children = [];
  },
  appendChild(parent: Instance, child: Instance): void {
    insertAt(parent.children, child);
    mountSubtree(child);
  },
  appendChildToContainer(root: RootContainer, child: Instance): void {
    insertAt(root.children, child);
    mountSubtree(child);
  },
  insertBefore(parent: Instance, child: Instance, before: Instance): void {
    insertAt(parent.children, child, before);
    mountSubtree(child);
  },
  insertInContainerBefore(root: RootContainer, child: Instance, before: Instance): void {
    insertAt(root.children, child, before);
    mountSubtree(child);
  },
  removeChild(parent: Instance, child: Instance): void {
    detach(parent.children, child);
    unmountSubtree(child);
  },
  removeChildFromContainer(root: RootContainer, child: Instance): void {
    detach(root.children, child);
    unmountSubtree(child);
  },
  commitUpdate(
    instance: Instance,
    _type: string,
    _prevProps: HostProps[InstanceKind],
    nextProps: HostProps[InstanceKind],
  ): void {
    if (instance.kind === 'network') {
      const prev = instance.spec;
      const next = propsToSpec('network', nextProps as NetworkHostProps);
      const changed = diffSpec('network', prev, next);
      if (changed.length === 0) return;
      instance.spec = next;
      if (next.name !== prev.name) return rename(instance, prev.name);
      if (instance.created)
        push(instance.root, { type: 'UPDATE', kind: 'network', id: instance.id, prev, next, changed });
      return;
    }

    const props = nextProps as ContainerHostProps;
    const prev = instance.spec;
    const next = propsToSpec('container', props);
    const changed = diffSpec('container', prev, next);
    const restarts = props.restarts ?? 0;

    if (changed.length > 0) {
      instance.spec = next;
      if (next.name !== prev.name) {
        // A fresh container starts at the current generation; no START needed.
        instance.restarts = restarts;
        return rename(instance, prev.name);
      }
      if (instance.created) {
        push(instance.root, { type: 'UPDATE', kind: 'container', id: instance.id, prev, next, changed });
      }
    }

    if (restarts !== instance.restarts) {
      instance.restarts = restarts;
      // A subtree that was never placed cannot be started; the CREATE that
      // eventually places it starts the container anyway.
      if (instance.created) {
        push(instance.root, { type: 'START', kind: 'container', id: instance.id, attempt: restarts });
      }
    }
  },
  commitTextUpdate(): void {
    /* unreachable: createTextInstance throws */
  },
  commitMount(): void {},
  resetTextContent(): void {},
  hideInstance(): void {
    // Called when an already-mounted subtree re-suspends. useReady latches,
    // so this only happens for user-thrown promises; a hidden container
    // keeps running. Stopping dependents is a policy for conditional render.
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
   * React's only use of this in concurrent mode is to throttle the commit
   * that replaces a Suspense fallback (about 300ms after the fallback was
   * shown, to avoid flashing). There is no UI to flash: a container gated by
   * <Ready> should be created the moment its dependency is up. So "later"
   * means the next microtask, still cancellable.
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
    // Every update outside an explicit priority is discrete, i.e. SyncLane.
    // A container spec has no "less urgent" changes, and sync lanes mean a
    // store event re-renders and commits in the next microtask (or on
    // `root.flush()`), with no Scheduler involvement. Suspense retries are
    // the exception: React picks a retry lane and goes through the Scheduler.
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

  // ---- suspending commits (unused) -----------------------------------------
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
 * `name` is identity. React kept the fiber (same key/type), but for the
 * runtime this is a different resource: tear down the old one and create
 * the new one. Children keep their own identity.
 */
function rename(instance: Instance, previousName: string): void {
  if (instance.created) {
    instance.created = false;
    instance.root.live.delete(liveKey(instance.kind, previousName));
    push(instance.root, { type: 'DELETE', kind: instance.kind, id: previousName });
  }
  instance.id = instance.spec.name;
  mountSubtree(instance);
}

/**
 * @types/react-reconciler lags the runtime (0.33 types vs 0.34 runtime), so
 * the config is authored as a plain object and cast once, here.
 */
export const typedHostConfig = hostConfig as unknown as HostConfig<
  HostType,
  HostProps[InstanceKind],
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
