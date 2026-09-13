/**
 * react-reconciler hostConfig for react4c.
 *
 * Two rules are fixed here and everything else is built on top of them:
 *
 *   1. spec = fiber tree. Host instances *are* the desired state. Runtime
 *      status (is the container alive?) lives outside the tree and is read
 *      with useSyncExternalStore (phase 1).
 *   2. commit executes nothing. Every host method is synchronous and only
 *      appends to `root.pending`. `resetAfterCommit` hands the batch to the
 *      sink; the sink is the only place a side effect may happen.
 */
import type { HostConfig } from 'react-reconciler';
import { DefaultEventPriority, NoEventPriority } from 'react-reconciler/constants';
import { diffSpec, type ContainerSpec, type Op, type OpSink } from './ops.js';

export type HostType = 'container';

/** Props accepted by the `container` host element. */
export interface ContainerHostProps extends ContainerSpec {
  children?: unknown;
}

export interface Instance {
  kind: 'container';
  /** Identity as seen by the runtime. Equal to `spec.name`. */
  id: string;
  spec: ContainerSpec;
  children: Instance[];
  root: RootContainer;
  /** True between the CREATE and DELETE ops for this instance. */
  created: boolean;
}

export interface RootContainer {
  kind: 'root';
  children: Instance[];
  /** Ops of the commit in flight. Flushed to `sink` in `resetAfterCommit`. */
  pending: Op[];
  /** Instances that currently have an outstanding CREATE. */
  live: Map<string, Instance>;
  sink: OpSink;
}

type HostContext = Record<never, never>;

export function createRootContainer(sink: OpSink): RootContainer {
  return { kind: 'root', children: [], pending: [], live: new Map(), sink };
}

const SPEC_KEYS = ['name', 'image', 'command', 'env', 'ports', 'labels'] as const;

function propsToSpec(type: string, props: ContainerHostProps): ContainerSpec {
  if (typeof props.name !== 'string' || props.name.length === 0) {
    throw new Error(`react4c: <${type}> requires a non-empty string "name"`);
  }
  if (typeof props.image !== 'string' || props.image.length === 0) {
    throw new Error(`react4c: <${type} name="${props.name}"> requires a non-empty string "image"`);
  }
  const spec: Record<string, unknown> = {};
  for (const key of SPEC_KEYS) {
    if (props[key] !== undefined) spec[key] = props[key];
  }
  return spec as unknown as ContainerSpec;
}

function push(root: RootContainer, op: Op): void {
  root.pending.push(op);
}

/** Emit CREATE for every not-yet-created instance in the subtree, parents first. */
function mountSubtree(instance: Instance): void {
  const root = instance.root;
  if (!instance.created) {
    if (root.live.has(instance.id)) {
      throw new Error(`react4c: duplicate container name "${instance.id}"`);
    }
    instance.created = true;
    root.live.set(instance.id, instance);
    push(root, { type: 'CREATE', kind: 'container', id: instance.id, spec: instance.spec });
  }
  for (const child of instance.children) mountSubtree(child);
}

/** Emit DELETE for the whole subtree, children first (reverse of creation). */
function unmountSubtree(instance: Instance): void {
  for (let i = instance.children.length - 1; i >= 0; i--) unmountSubtree(instance.children[i]!);
  if (instance.created) {
    instance.created = false;
    instance.root.live.delete(instance.id);
    push(instance.root, { type: 'DELETE', kind: 'container', id: instance.id });
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
  rendererPackageName: 'react4c',
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
  createInstance(type: string, props: ContainerHostProps, root: RootContainer): Instance {
    if (type !== 'container') {
      throw new Error(`react4c: unknown host element <${type}>. Only <container> is supported.`);
    }
    const spec = propsToSpec(type, props);
    return { kind: 'container', id: spec.name, spec, children: [], root, created: false };
  },
  createTextInstance(text: string): never {
    throw new Error(
      `react4c: text is not allowed in the tree (got ${JSON.stringify(text)}). ` +
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
    if (root.pending.length === 0) return;
    const batch = root.pending;
    root.pending = [];
    root.sink(batch);
  },
  clearContainer(root: RootContainer): void {
    for (let i = root.children.length - 1; i >= 0; i--) unmountSubtree(root.children[i]!);
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
    type: string,
    _prevProps: ContainerHostProps,
    nextProps: ContainerHostProps,
  ): void {
    const prev = instance.spec;
    const next = propsToSpec(type, nextProps);
    const changed = diffSpec(prev, next);
    if (changed.length === 0) return;

    instance.spec = next;
    if (next.name !== prev.name) {
      // `name` is identity. React kept the fiber (same key/type), but for the
      // runtime this is a different container: tear down the old one and
      // create the new one. Children keep their own identity.
      if (instance.created) {
        instance.created = false;
        instance.root.live.delete(prev.name);
        push(instance.root, { type: 'DELETE', kind: 'container', id: prev.name });
      }
      instance.id = next.name;
      mountSubtree(instance);
      return;
    }
    if (!instance.created) return; // a subtree that was never placed cannot be updated
    push(instance.root, { type: 'UPDATE', kind: 'container', id: instance.id, prev, next, changed });
  },
  commitTextUpdate(): void {
    /* unreachable: createTextInstance throws */
  },
  commitMount(): void {},
  resetTextContent(): void {},
  hideInstance(): void {
    // Suspense/Activity hiding is a phase-2 concern (dependency ordering).
    // Until then a hidden container keeps running.
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
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1 as const,
  scheduleMicrotask: queueMicrotask,
  getCurrentUpdatePriority(): number {
    return currentUpdatePriority;
  },
  setCurrentUpdatePriority(priority: number): void {
    currentUpdatePriority = priority;
  },
  resolveUpdatePriority(): number {
    return currentUpdatePriority !== NoEventPriority ? currentUpdatePriority : DefaultEventPriority;
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

  // ---- suspending commits (unused until phase 2) -------------------------
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
 * @types/react-reconciler lags the runtime (0.33 types vs 0.34 runtime), so
 * the config is authored as a plain object and cast once, here.
 */
export const typedHostConfig = hostConfig as unknown as HostConfig<
  HostType,
  ContainerHostProps,
  RootContainer,
  Instance,
  never,
  never,
  never,
  Instance,
  HostContext,
  null,
  never,
  ReturnType<typeof setTimeout>,
  -1,
  null
>;
