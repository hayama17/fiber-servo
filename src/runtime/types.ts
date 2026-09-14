/**
 * The runtime boundary.
 *
 * Above this line everything is declarative. Below it is the only place
 * allowed to know how a container actually gets created — and after the move
 * to Compose, even that is mostly delegated: the adapter hands a whole
 * application model to an actuator and reads the result back.
 *
 * An adapter owes the control plane two things, and they come from different
 * places on purpose:
 *
 *   apply / down   the write path — `nerdctl compose`, which owns image
 *                  pulling, network creation and running containers
 *   inspect /      the read path — containerd's own gRPC API, which owns
 *   subscribe      what is actually running
 *
 * The seam is **who owns the resource**, not read-versus-write. An earlier
 * design split it the other way and ended up talking to one dependency three
 * ways, with an exception in its own headline rule; see `docs/decisions.md`.
 */
import type { ComposeApplication } from '../compose.js';

// ---- observed state --------------------------------------------------------

/**
 * Where a container is in its life. `waiting` covers created-but-not-running;
 * `unknown` is what you get before the first observation, and is never
 * treated as "absent" — absence is the container not appearing at all.
 */
export type ContainerPhase = 'waiting' | 'running' | 'exited' | 'unknown';

/**
 * One container as the runtime currently holds it.
 *
 * `name` is the Compose service name, which is the name fiber-servo's
 * controllers chose (`api-0`, `web-43bfee23-1`). Compose mangles the actual
 * container name to `<project>-<service>-<index>` but records the service
 * name in a label, so identity survives the round trip without fiber-servo
 * having to invent a label of its own.
 */
export interface ObservedContainer {
  readonly name: string;
  /** containerd's id, which is not the name. */
  readonly id?: string;
  readonly phase: ContainerPhase;
  readonly exitCode?: number;
  /** Set by the readiness prober once the container answers its probe. */
  readonly ready?: boolean;
  readonly image?: string;
  /** Networks it is attached to, read back from nerdctl's own label. */
  readonly networks: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  /**
   * `digest()` of the ContainerSpec it was created from, from the
   * `fiber-servo.spec` label.
   *
   * This is the whole of the change-detection mechanism. It answers "is this
   * container still the one we asked for", which is all the write path needs:
   * the response to any difference is the same — remove this one service and
   * let `compose up` recreate it — so nothing has to know *which* field moved.
   */
  readonly specDigest?: string;
  /** `Date.now()` of the observation. */
  readonly at: number;
}

/**
 * Everything the runtime currently holds, as one immutable snapshot.
 *
 * Networks are deliberately absent. Compose creates and removes them as part
 * of applying the model, so nothing in the control plane decides anything
 * about them and nothing needs to read them. A container's own attachments
 * are on `ObservedContainer.networks` for diagnostics.
 */
export interface ObservedState {
  readonly containers: ReadonlyMap<string, ObservedContainer>;
  /** Bumped on every change, so a reader can tell two snapshots apart cheaply. */
  readonly revision: number;
}

/**
 * The mutable store behind those snapshots. The runtime watcher writes; the
 * control loop reads and subscribes.
 *
 * This is the *only* path by which reality reaches the control plane. It is
 * deliberately not React state: a container dying is not a change to what we
 * want, so it must not look like one.
 */
export interface ObservedStore {
  snapshot(): ObservedState;
  get(name: string): ObservedContainer | undefined;
  /** Replace what is known about one container. */
  set(container: ObservedContainer): void;
  /** Merge a partial observation, keeping fields not mentioned. */
  patch(name: string, patch: ContainerPatch): void;
  remove(name: string): void;
  /** Replace the whole snapshot, as a full resync from `Runtime.inspect` does. */
  reset(containers: Iterable<ObservedContainer>): void;
  subscribe(listener: () => void): () => void;
}

export type ContainerPatch = Partial<Omit<ObservedContainer, 'name'>>;

// ---- the adapter -----------------------------------------------------------

export type Unsubscribe = () => void;

/** A change the runtime noticed on its own. */
export type RuntimeEvent =
  | { type: 'container'; container: ObservedContainer }
  | { type: 'container-removed'; name: string }
  | { type: 'resync'; containers: readonly ObservedContainer[] };

export type RuntimeEventListener = (event: RuntimeEvent) => void | Promise<void>;

/**
 * What it takes to run an application on one machine.
 *
 * `apply` is the whole write path. It takes the complete desired application,
 * not a list of operations: deciding that a changed image means "remove this
 * service, then recreate it" is the adapter's business, and it is the only
 * layer that knows the actuator well enough to decide it.
 *
 * It must be idempotent. The control loop is level-triggered and will call it
 * again on every observation, so applying an unchanged model has to be a
 * no-op — an actuator that recreates containers on every apply would churn
 * the whole application for ever. (`nerdctl compose up` does exactly that;
 * see the adapter for what it does instead.)
 */
export interface Runtime {
  /** Make the machine match this application. Idempotent. */
  apply(model: ComposeApplication): Promise<void>;
  /** Remove the whole application. */
  down(): Promise<void>;

  /** Full resync. Called at startup and whenever the event stream is doubted. */
  inspect(): Promise<ObservedState>;
  /** Stream changes until the returned function is called, in order. */
  subscribe(listener: RuntimeEventListener): Unsubscribe;

  /** Optional: release watchers, child processes and the like. */
  close?(): Promise<void>;
}

/** How a `Runtime` is built. Gives the adapter a logger and an error channel. */
export interface RuntimeContext {
  log: (line: string) => void;
  onError: (error: Error) => void;
  /**
   * The Compose project the control loop will apply as — the `name` of every
   * `ComposeApplication` this adapter is about to receive.
   *
   * An adapter needs it before the first `apply`, to know which of the
   * machine's containers are this tree's when `inspect()` is called. It is
   * passed down rather than configured on the adapter so that there is one
   * place to set it: an adapter filtering reads by one project while the loop
   * applies another observes an empty world and recreates the application on
   * every pass, for ever. (The same hazard as the containerd namespace, and
   * it is settled the same way.)
   */
  project: string;
}

export type RuntimeFactory = (ctx: RuntimeContext) => Runtime;
