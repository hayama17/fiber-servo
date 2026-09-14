/**
 * The in-memory `Runtime`: everything a real adapter does, minus containerd.
 *
 * This is not a mock. A mock stands in for a `Runtime` and asserts on how it
 * was called; this file *is* one — the smallest complete implementation of
 * the contract in `./types.ts`. It keeps real Pods (a map, not a database),
 * derives Pod phase from container phase the same way the docs on
 * `ObservedPod` say an adapter must, records a spec digest the way a real
 * adapter stores one in a label, and emits the same `RuntimeEvent`s a
 * containerd watcher would.
 *
 * That the whole control plane — planner, controllers, reconciler — can be
 * exercised end to end against this file without containerd running anywhere
 * is not a trick. It is the direct payoff of the runtime boundary in
 * `types.ts` being declarative: nothing above that boundary knows or cares
 * that "creating a Pod" here is a `Map.set` instead of a gRPC call to a CRI
 * shim. Swap this file for `./containerd` and the rest of the project does
 * not need to know.
 */
import type { ContainerSpec, NetworkSpec, PodSpec, ResourceLimits } from '../resources.js';
import { digest } from '../resources.js';
import type {
  ContainerPhase,
  ObservedContainer,
  ObservedNetwork,
  ObservedPod,
  ObservedState,
  PodPhase,
  Runtime,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeFactory,
  Unsubscribe,
} from './types.js';

export interface MemoryRuntimeOptions {
  log?: (line: string) => void;
  /** Pods start `running` immediately when true (the default). False leaves them `pending`. */
  autoStart?: boolean;
  /** Containers with a readiness probe report ready immediately when true (the default). */
  autoReady?: boolean;
  now?: () => number;
}

export interface MemoryRuntime extends Runtime {
  /** Every call made, in order, as readable strings. The assertion surface for tests. */
  readonly calls: readonly string[];
  /** Test hook: make a Pod look like it died, without anyone asking for it. */
  kill(pod: string, detail?: { exitCode?: number; reason?: string }): void;
  /** Test hook: mark one container ready. */
  markReady(pod: string, container: string, ready?: boolean): void;
}

// ---- internal state ---------------------------------------------------------
//
// The public shape (`ObservedPod`/`ObservedContainer`) is immutable and
// recomputed on demand; what is actually stored is a plainer, mutable record
// so a mutation is just an assignment, not a rebuild of a nested tree.

interface InternalContainer {
  readonly name: string;
  /** The runtime's own handle -- `podName/containerName`, per `resources.ts`. */
  readonly id: string;
  image: string;
  phase: ContainerPhase;
  exitCode?: number;
  /** Only meaningful when the spec carried a `readiness` probe. */
  ready?: boolean;
  readonly hasReadiness: boolean;
  /**
   * The one thing `updateContainerResources` changes. Deliberately not part
   * of `ObservedContainer` -- the control plane already knows what it asked
   * for; a real runtime does not hand cgroup limits back on every observation
   * either, only lifecycle state.
   */
  resources?: ResourceLimits;
}

interface InternalPod {
  readonly name: string;
  readonly id: string;
  readonly ip: string;
  labels: Record<string, string>;
  readonly specDigest: string;
  /**
   * The spec this Pod is currently built from. A real adapter keeps this in a
   * label; keeping it here is the same promise, and it is what lets the
   * planner tell a cpu change from an image change.
   */
  spec: PodSpec;
  readonly containers: Map<string, InternalContainer>;
}

/**
 * `ObservedPod.phase` is derived from its containers, per the contract in
 * `types.ts` ("running once the sandbox and every container are up, exited
 * once ... every container has stopped"). Storing phase on the Pod itself
 * would let it drift from its containers; deriving it here makes that
 * impossible.
 */
function derivePodPhase(containers: Iterable<InternalContainer>): PodPhase {
  const list = [...containers];
  if (list.length === 0) return 'pending';
  if (list.some((c) => c.phase === 'unknown')) return 'unknown';
  if (list.every((c) => c.phase === 'running')) return 'running';
  if (list.every((c) => c.phase === 'exited')) return 'exited';
  return 'pending';
}

function formatResources(r: ResourceLimits): string {
  const parts: string[] = [];
  if (r.cpu !== undefined) parts.push(`cpu=${r.cpu}`);
  if (r.memory !== undefined) parts.push(`memory=${r.memory}`);
  return parts.join(' ');
}

export function createMemoryRuntime(options: MemoryRuntimeOptions = {}): MemoryRuntime {
  const log = options.log ?? (() => {});
  const autoStart = options.autoStart ?? true;
  const autoReady = options.autoReady ?? true;
  const now = options.now ?? (() => Date.now());

  const pods = new Map<string, InternalPod>();
  const networks = new Map<string, ObservedNetwork>();
  const listeners = new Set<RuntimeEventListener>();
  const calls: string[] = [];
  let revision = 0;
  let podCounter = 0;
  let ipCounter = 1;

  const record = (line: string): void => {
    calls.push(line);
    log(line);
  };

  const notify = (event: RuntimeEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        log(`fiber-servo: subscriber threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const toObservedContainer = (c: InternalContainer): ObservedContainer => ({
    name: c.name,
    id: c.id,
    phase: c.phase,
    exitCode: c.exitCode,
    ready: c.ready,
    image: c.image,
  });

  const toObservedPod = (pod: InternalPod): ObservedPod => ({
    name: pod.name,
    id: pod.id,
    phase: derivePodPhase(pod.containers.values()),
    ip: pod.ip,
    labels: pod.labels,
    specDigest: pod.specDigest,
    spec: pod.spec,
    containers: [...pod.containers.values()].map(toObservedContainer),
    at: now(),
  });

  const buildContainer = (podName: string, spec: ContainerSpec): InternalContainer => ({
    name: spec.name,
    id: `${podName}/${spec.name}`,
    image: spec.image,
    hasReadiness: Boolean(spec.readiness),
    phase: autoStart ? 'running' : 'waiting',
    ready: spec.readiness ? autoStart && autoReady : undefined,
  });

  const buildPod = (spec: PodSpec, specDigest: string): InternalPod => {
    podCounter += 1;
    const containers = new Map<string, InternalContainer>();
    for (const c of spec.containers) containers.set(c.name, buildContainer(spec.name, c));
    return {
      name: spec.name,
      id: `sandbox-${podCounter}`,
      ip: `10.42.0.${++ipCounter}`,
      labels: { ...(spec.labels ?? {}) },
      specDigest,
      spec,
      containers,
    };
  };

  const runtime: MemoryRuntime = {
    get calls(): readonly string[] {
      return calls;
    },

    async createNetwork(spec: NetworkSpec): Promise<void> {
      record(`createNetwork ${spec.name}`);
      // Idempotent: a resync may legitimately ask for a Network we already
      // hold. Throwing here would turn every restart into a conflict instead
      // of a no-op, which is exactly the crash-recovery case this guards.
      if (networks.has(spec.name)) return;
      networks.set(spec.name, { name: spec.name, subnet: spec.subnet });
      revision += 1;
    },

    async removeNetwork(name: string): Promise<void> {
      record(`removeNetwork ${name}`);
      if (!networks.has(name)) return; // idempotent: already gone
      networks.delete(name);
      revision += 1;
    },

    async createPod(spec: PodSpec): Promise<void> {
      record(`createPod ${spec.name}`);
      const specDigest = digest(spec);
      const existing = pods.get(spec.name);
      // Idempotent: after a resync the control loop may ask to create a Pod
      // it already owns. Same digest means it is the exact Pod we already
      // have -- a no-op, not an error. An adapter that threw here would make
      // crash recovery impossible, since every restart would look like a
      // naming conflict instead of the resync it actually is.
      if (existing && existing.specDigest === specDigest) return;
      // A different digest under a name we already hold means the planner
      // decided to replace this Pod (see `PodTemplate`: any change to it
      // replaces rather than mutates). Recreate it honestly -- this is what
      // containerd would show too, after `rm -f` followed by `run`.
      const pod = buildPod(spec, specDigest);
      pods.set(spec.name, pod);
      revision += 1;
      notify({ type: 'pod', pod: toObservedPod(pod) });
    },

    async removePod(name: string): Promise<void> {
      record(`removePod ${name}`);
      if (!pods.has(name)) return; // idempotent: unknown Pod, nothing to do
      pods.delete(name);
      revision += 1;
      notify({ type: 'pod-removed', name });
    },

    async createContainer(pod: string, spec: ContainerSpec): Promise<void> {
      record(`createContainer ${pod}/${spec.name} image=${spec.image}`);
      const target = pods.get(pod);
      if (!target) {
        throw new Error(`fiber-servo: cannot create container "${spec.name}": Pod "${pod}" does not exist`);
      }
      if (target.containers.has(spec.name)) return; // idempotent, same reasoning as createPod
      target.containers.set(spec.name, buildContainer(pod, spec));
      target.spec = { ...target.spec, containers: [...target.spec.containers, spec] };
      revision += 1;
      notify({ type: 'container', pod, container: toObservedContainer(target.containers.get(spec.name)!) });
    },

    async removeContainer(pod: string, name: string): Promise<void> {
      record(`removeContainer ${pod}/${name}`);
      const target = pods.get(pod);
      if (!target || !target.containers.has(name)) return; // idempotent: nothing to remove
      target.containers.delete(name);
      target.spec = { ...target.spec, containers: target.spec.containers.filter((c) => c.name !== name) };
      revision += 1;
      // There is no "container removed" event: removal is observed as the
      // container no longer appearing in the Pod's own `containers` list, so
      // the Pod is what gets re-announced.
      notify({ type: 'pod', pod: toObservedPod(target) });
    },

    async updateContainerResources(pod: string, container: string, resources: ResourceLimits): Promise<void> {
      record(`updateContainerResources ${pod}/${container} ${formatResources(resources)}`);
      const c = pods.get(pod)?.containers.get(container);
      if (!c) {
        throw new Error(
          `fiber-servo: cannot update resources: container "${pod}/${container}" does not exist`,
        );
      }
      c.resources = resources;
      const owner = pods.get(pod)!;
      owner.spec = {
        ...owner.spec,
        containers: owner.spec.containers.map((s) => (s.name === container ? { ...s, resources } : s)),
      };
      revision += 1;
      // Nothing observable changes -- resources are not part of
      // `ObservedContainer` -- but a mutation happened, so subscribers still
      // hear about it, the same as a real runtime firing an "update" event.
      notify({ type: 'container', pod, container: toObservedContainer(c) });
    },

    async inspect(): Promise<ObservedState> {
      record('inspect');
      return {
        pods: new Map([...pods].map(([name, pod]) => [name, toObservedPod(pod)])),
        networks: new Map(networks),
        revision,
      };
    },

    subscribe(listener: RuntimeEventListener): Unsubscribe {
      record('subscribe');
      listeners.add(listener);
      return () => {
        record('unsubscribe');
        listeners.delete(listener);
      };
    },

    async close(): Promise<void> {
      record('close');
      listeners.clear();
    },

    kill(pod: string, detail?: { exitCode?: number; reason?: string }): void {
      const detailText = [
        detail?.exitCode !== undefined ? `exitCode=${detail.exitCode}` : undefined,
        detail?.reason !== undefined ? `reason=${detail.reason}` : undefined,
      ]
        .filter((s): s is string => s !== undefined)
        .join(' ');
      record(`kill ${pod}${detailText ? ` ${detailText}` : ''}`);
      const target = pods.get(pod);
      if (!target) throw new Error(`fiber-servo: cannot kill "${pod}": Pod does not exist`);
      for (const c of target.containers.values()) {
        c.phase = 'exited';
        c.exitCode = detail?.exitCode;
        if (c.hasReadiness) c.ready = false;
      }
      revision += 1;
      notify({ type: 'pod', pod: toObservedPod(target) });
    },

    markReady(pod: string, container: string, ready = true): void {
      record(`markReady ${pod}/${container} ready=${ready}`);
      const c = pods.get(pod)?.containers.get(container);
      if (!c)
        throw new Error(`fiber-servo: cannot mark ready: container "${pod}/${container}" does not exist`);
      c.ready = ready;
      revision += 1;
      notify({ type: 'container', pod, container: toObservedContainer(c) });
    },
  };

  return runtime;
}

/** As a `RuntimeFactory`, for `serve()`. */
export function memory(options: MemoryRuntimeOptions = {}): RuntimeFactory {
  return (ctx) => createMemoryRuntime({ ...options, log: options.log ?? ctx.log });
}
