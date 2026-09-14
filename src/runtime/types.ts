/**
 * The runtime boundary.
 *
 * Above this line everything is declarative: specs describing what should
 * exist. Below it is the only place in the project allowed to know that
 * bringing up a Pod means "create a sandbox, then create containers, then
 * start them" — and that sequence never leaks upwards.
 *
 * An adapter owes the control plane two things:
 *
 *   apply     make one named resource match a spec, or be gone
 *   observe   report what is actually there, now and as it changes
 *
 * The second is not optional and not a nicety: controllers compare desired
 * against observed, so an adapter that cannot be observed cannot be
 * reconciled.
 */
import type { ContainerSpec, NetworkSpec, PodSpec, ResourceLimits } from '../resources.js';

// ---- observed state --------------------------------------------------------

/**
 * Where a container is in its life. `waiting` covers created-but-not-running;
 * `unknown` is what you get before the first observation, and is never
 * treated as "absent" — absence is the resource not appearing at all.
 */
export type ContainerPhase = 'waiting' | 'running' | 'exited' | 'unknown';

/**
 * A Pod's phase is derived from its containers by the adapter: `running` once
 * the sandbox and every container are up, `exited` once the sandbox is gone
 * or every container has stopped.
 */
export type PodPhase = 'pending' | 'running' | 'exited' | 'unknown';

export interface ObservedContainer {
  /** Identity within the Pod. */
  readonly name: string;
  /** The runtime's own handle, when it has one. */
  readonly id?: string;
  readonly phase: ContainerPhase;
  readonly exitCode?: number;
  /** Set by the readiness prober once the container answers its probe. */
  readonly ready?: boolean;
  readonly image?: string;
}

export interface ObservedPod {
  readonly name: string;
  readonly id?: string;
  readonly phase: PodPhase;
  /** Address inside its Network. What a Service routes to. */
  readonly ip?: string;
  readonly labels: Readonly<Record<string, string>>;
  /**
   * `digest(spec)` of the PodSpec this Pod was created from, when the adapter
   * recorded one. Lets the control plane recognise a Pod it already owns
   * across a process restart instead of replacing it.
   */
  readonly specDigest?: string;
  /**
   * The PodSpec this Pod was created from, as the adapter recorded it — in a
   * label, for containerd.
   *
   * This is what makes the immutability model possible. Comparing a desired
   * spec against a live Pod tells you only *that* something differs; comparing
   * it against the spec the Pod was created from tells you *which field*, and
   * therefore whether the change can be applied in place (cpu) or needs a
   * replacement (image). Storing it on the resource rather than in the
   * process is what lets a restarted fiber-servo answer that question too.
   *
   * Absent when the Pod was not created by fiber-servo, or by a version that
   * did not record it: the planner then falls back to `specDigest`.
   */
  readonly spec?: PodSpec;
  readonly containers: readonly ObservedContainer[];
  /** `Date.now()` of the observation. */
  readonly at: number;
}

export interface ObservedNetwork {
  readonly name: string;
  readonly subnet?: string;
}

/** Everything the runtime currently holds, as one immutable snapshot. */
export interface ObservedState {
  readonly pods: ReadonlyMap<string, ObservedPod>;
  readonly networks: ReadonlyMap<string, ObservedNetwork>;
  /** Bumped on every change, so a reader can tell two snapshots apart cheaply. */
  readonly revision: number;
}

/**
 * The mutable store behind those snapshots. Runtime watchers write; the
 * control loop reads and subscribes.
 *
 * This is the *only* path by which reality reaches the control plane. It is
 * deliberately not a React state hook: a Pod dying is not a change to what we
 * want, so it must not look like one.
 */
export interface ObservedStore {
  snapshot(): ObservedState;
  getPod(name: string): ObservedPod | undefined;
  /** Replace what is known about one Pod. */
  setPod(pod: ObservedPod): void;
  /** Merge a partial observation into the Pod, keeping fields not mentioned. */
  patchPod(name: string, patch: PodPatch): void;
  /** Amend one container inside a Pod (a readiness result, an exit code). */
  patchContainer(pod: string, container: string, patch: ContainerPatch): void;
  removePod(name: string): void;
  setNetwork(network: ObservedNetwork): void;
  removeNetwork(name: string): void;
  /** Replace the whole snapshot, as a full resync from `Runtime.inspect` does. */
  reset(state: Pick<ObservedState, 'pods' | 'networks'>): void;
  subscribe(listener: () => void): () => void;
}

export type PodPatch = Partial<Omit<ObservedPod, 'name' | 'containers'>>;
export type ContainerPatch = Partial<Omit<ObservedContainer, 'name'>>;

// ---- the adapter -----------------------------------------------------------

export type Unsubscribe = () => void;

/**
 * A change the runtime noticed on its own. Adapters emit these from whatever
 * event source they have (`nerdctl events`, a CRI stream, a poll); the
 * control plane does not care which.
 */
export type RuntimeEvent =
  | { type: 'pod'; pod: ObservedPod }
  | { type: 'pod-removed'; name: string }
  | { type: 'container'; pod: string; container: ObservedContainer }
  | { type: 'resync'; state: Pick<ObservedState, 'pods' | 'networks'> };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/**
 * What it takes to realize Pods on one machine.
 *
 * Every method is a statement about a single named resource, and each is
 * expected to be idempotent: the control loop may call `createPod` for a Pod
 * that already exists after a resync, and should get a no-op rather than an
 * error. Ordering between resources (network before the Pods on it) is the
 * control loop's business, not the adapter's.
 */
export interface Runtime {
  createNetwork(spec: NetworkSpec): Promise<void>;
  removeNetwork(name: string): Promise<void>;

  /** Create the sandbox and every container in `spec`, and start them. */
  createPod(spec: PodSpec): Promise<void>;
  removePod(name: string): Promise<void>;

  /** Add one container to an existing sandbox. */
  createContainer(pod: string, spec: ContainerSpec): Promise<void>;
  removeContainer(pod: string, name: string): Promise<void>;
  /**
   * The one in-place mutation. Everything else about a container is immutable
   * and a change to it is a replacement, decided by the planner.
   */
  updateContainerResources(pod: string, container: string, resources: ResourceLimits): Promise<void>;

  /** Full resync. Called at startup and whenever the event stream is doubted. */
  inspect(): Promise<ObservedState>;
  /** Stream changes until the returned function is called. */
  subscribe(listener: RuntimeEventListener): Unsubscribe;

  /** Optional: release watchers, child processes and the like. */
  close?(): Promise<void>;
}

/** How a `Runtime` is built. Gives the adapter a logger and an error channel. */
export interface RuntimeContext {
  log: (line: string) => void;
  onError: (error: Error) => void;
}

export type RuntimeFactory = (ctx: RuntimeContext) => Runtime;
