/**
 * The vocabulary. Every layer below React speaks these types and nothing else.
 *
 * A spec says *what should exist*, never how to get there. No layer here may
 * contain a verb like stop, delete or start: deciding that a changed field
 * means "recreate the container" is the planner's job (see `planner.ts`), and
 * carrying it out is the runtime adapter's.
 *
 * Two families live here:
 *
 *   management resources  Deployment, ReplicaSet. Policies. They describe how
 *                         many of something should exist and how it should be
 *                         rolled out. Controllers turn them into Containers.
 *
 *   runtime resources     Network, Container, Service. Things a runtime
 *                         actually materializes.
 *
 * Ownership is a tree (a Deployment owns ReplicaSets, a ReplicaSet owns
 * Containers) and it is expressed by nesting. Relationships are a graph (a
 * Container attaches to a Network, a Service selects Containers) and they are
 * expressed by *name*, never by nesting.
 */

/** A host port bound to a port inside the container. */
export interface PortMapping {
  host: number;
  /** Port inside the container. */
  target: number;
  protocol?: 'tcp' | 'udp';
}

/**
 * How a runtime decides a running container is ready to be depended on.
 * `exec` runs inside the container; exit 0 means ready.
 */
export interface ReadinessProbe {
  exec: readonly string[];
  /** Time between attempts. Default 2000. */
  intervalMs?: number;
}

/**
 * Allocatable limits. These are the one part of a container a runtime can
 * usually change without replacing the process, which is why they are grouped
 * apart from the rest of the spec.
 */
export interface ResourceLimits {
  /** CPU cores; 0.5 means half a core. */
  cpu?: number;
  /** Memory, as the runtime's unit string: "512m", "2g". */
  memory?: string;
}

/**
 * One container: the unit of everything.
 *
 * A ReplicaSet counts these, a Service routes to them, and one of these
 * becomes exactly one Compose service. There is no Pod: an earlier design
 * had one, emulated out of an infra container plus members sharing its
 * network namespace, and it bought sidecars at the price of building by hand
 * a thing neither containerd nor Compose has. The unit is the container.
 *
 * `name` is the identity. Everything else except `resources` is fixed at
 * creation — a change to it means this container is replaced, not edited.
 */
export interface ContainerSpec {
  name: string;
  image: string;
  command?: readonly string[];
  env?: Readonly<Record<string, string>>;
  /** Ports the process listens on. Documentation for Services; not published. */
  ports?: readonly number[];
  /** Attaches to this Network, by name. Undefined means the default. */
  network?: string;
  /** Key/value pairs a Service selector matches against. */
  labels?: Readonly<Record<string, string>>;
  /** Host ports to bind. A replicated container should not set these: replicas would collide. */
  publish?: readonly PortMapping[];
  resources?: ResourceLimits;
  /** With a probe, dependents wait for `ready`, not merely `running`. */
  readiness?: ReadinessProbe;
}

/**
 * A container without an identity: what a ReplicaSet stamps out `replicas`
 * times. Keeping the template separate from `ContainerSpec` is what lets a
 * ReplicaSet own "three of these" rather than three fixed names.
 */
export type ContainerTemplate = Omit<ContainerSpec, 'name'>;

/**
 * A local bridge network: roughly a Docker user-defined network. Containers on
 * the same Network reach each other by name; the fields other than `name` are immutable
 * once created, so changing one replaces the Network.
 */
export interface NetworkSpec {
  name: string;
  subnet?: string;
  labels?: Readonly<Record<string, string>>;
}

/**
 * A stable endpoint in front of whichever containers currently match
 * `selector`.
 *
 * The set of backends is *not* in this spec: it is resolved from observed
 * state by the Service controller, because containers come and go without the
 * React tree changing. That is also why a Service exists rather than
 * publishing a host port on each replica — replicas would collide on it.
 */
export interface ServiceSpec {
  name: string;
  /** Matches a container when every entry here equals its label of that key. */
  selector: Readonly<Record<string, string>>;
  /** Network the data plane sits on. Must be the one its backing containers are on. */
  network?: string;
  /** Port the Service listens on inside the network. */
  port: number;
  /** Port on the backing containers. Default: `port`. */
  targetPort?: number;
  /** Host port to bind, when the Service should be reachable from outside. */
  publish?: number;
}

/**
 * "Keep `replicas` containers of this template alive."
 *
 * A ReplicaSet names a *count*, not identities. When a container dies the
 * desired state has not changed — observed state has — so its controller, not
 * React, is what notices and replaces it.
 */
export interface ReplicaSetSpec {
  name: string;
  replicas: number;
  template: ContainerTemplate;
}

/** How a Deployment moves from one template generation to the next. */
export interface RolloutStrategy {
  /** Extra containers allowed above `replicas` while rolling. Default 1. */
  maxSurge?: number;
  /** Containers allowed to be missing below `replicas` while rolling. Default 0. */
  maxUnavailable?: number;
}

/**
 * A rollout policy over ReplicaSets. Editing the template does not edit
 * containers in place: it creates a new generation and the Deployment
 * controller shifts replicas from the old ReplicaSet to the new one.
 */
export interface DeploymentSpec {
  name: string;
  replicas: number;
  template: ContainerTemplate;
  strategy?: RolloutStrategy;
}

/** Every resource kind React can commit, and the spec each carries. */
export interface Specs {
  network: NetworkSpec;
  container: ContainerSpec;
  service: ServiceSpec;
  replicaset: ReplicaSetSpec;
  deployment: DeploymentSpec;
}

export type ResourceKind = keyof Specs;

/** A resource as it sits in a desired-state snapshot. */
export type Resource = { [K in ResourceKind]: { kind: K; name: string; spec: Specs[K] } }[ResourceKind];

/**
 * What one React commit produces: the complete set of resources that should
 * exist, in tree order. Not a diff — a snapshot.
 *
 * This is the single output of the React layer, and it replaces the op stream
 * the reconciler used to emit. React says what should exist; deciding what to
 * do about it belongs to the controllers and the runtime adapter, which can
 * see observed state and therefore know whether anything needs doing at all.
 */
export interface DesiredState {
  readonly resources: readonly Resource[];
}

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  'network',
  'container',
  'service',
  'replicaset',
  'deployment',
];

/** One member of the `Resource` union, picked by kind. */
export type ResourceOf<K extends ResourceKind> = Extract<Resource, { kind: K }>;

/** The resources of one kind, in tree order. */
export function resourcesOfKind<K extends ResourceKind>(desired: DesiredState, kind: K): ResourceOf<K>[] {
  return desired.resources.filter((r): r is ResourceOf<K> => r.kind === kind);
}

/** Structural equality for the JSON-shaped values a spec can hold. */
export function specValueEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => specValueEquals(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  return ak.length === bk.length && ak.every((k) => k in bo && specValueEquals(ao[k], bo[k]));
}

/**
 * A short, stable hash of a spec. Used for two things: naming a template
 * generation (a Deployment's ReplicaSets are keyed by it) and recognising a
 * resource the runtime already holds as the one we meant to create.
 */
export function digest(value: unknown): string {
  const json = stableJson(value);
  // FNV-1a, 32 bit. Short and readable in a container name; collisions here
  // only cost an unnecessary rollout, never correctness of identity.
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** JSON with object keys sorted, so a digest does not depend on key order. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/** True when every entry of `selector` matches `labels`. An empty selector matches nothing. */
export function selectorMatches(
  selector: Readonly<Record<string, string>>,
  labels: Readonly<Record<string, string>> | undefined,
): boolean {
  const entries = Object.entries(selector);
  if (entries.length === 0) return false;
  return entries.every(([k, v]) => labels?.[k] === v);
}
