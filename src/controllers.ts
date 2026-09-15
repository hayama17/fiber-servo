/**
 * Controllers: the part of "React reconciles management resources, controllers
 * reconcile runtime resources" (PLAN.md, "Core principle") that turns policy
 * into Containers.
 *
 * A Deployment or ReplicaSet says "I want N of this template." It does not
 * say which N: the identities of the Containers that satisfy it are a naming
 * scheme, not a decision anyone makes at apply time. Every function here is a
 * pure, synchronous `(desired, observed) => containers` — no I/O, no timers,
 * no runtime calls, nothing remembered between calls. That purity is not a
 * style preference: it is what lets "desired 3 vs actual 2" (PLAN.md,
 * "Observed state") be asserted in a test without a container runtime
 * anywhere in sight, and it is why every function below takes its inputs as
 * plain values and returns plain values instead of reaching into a store.
 *
 * Two management resources, three functions:
 *
 *   Deployment   -> expandDeployment  -> ReplicaSets (one per template
 *                                        generation, during a rollout: two)
 *   ReplicaSet   -> expandReplicaSet  -> Containers (exactly `replicas` of
 *                                        them)
 *   Service      -> serviceEndpoints, serviceProxyContainer -> a data-plane
 *                                        Container
 *
 * `runControllers` is the one entry point the control loop calls: it walks a
 * `DesiredState` snapshot once and returns the flat Network/Container set
 * that should exist right now. Everything downstream of that — building the
 * Compose Application Model from it and handing it to an actuator — belongs
 * to `serve.ts` and the `Runtime` adapter; this module only ever says what
 * *should* exist.
 *
 * What is deliberately NOT here: crash-loop backoff. Recognising "this
 * container keeps dying, slow down" needs memory from one tick to the next
 * (a counter, a timer), and this module keeps none. That bookkeeping belongs
 * to the control loop that calls `runControllers` on a schedule — it is not
 * missing here, it is just not this layer's job.
 */
import {
  digest,
  selectorMatches,
  type ContainerSpec,
  type ContainerTemplate,
  type DeploymentSpec,
  type DesiredState,
  type NetworkSpec,
  type ReplicaSetSpec,
  type ServiceSpec,
} from './resources.js';
import type { ObservedContainer, ObservedState } from './runtime/types.js';

/** Label keys the controllers stamp on the Containers they own, so ownership is visible at runtime. */
export const OWNER_LABEL = 'fiber-servo.owner';
export const GENERATION_LABEL = 'fiber-servo.generation';

// ---- ReplicaSet -------------------------------------------------------------

/**
 * Combine a template's user labels with the two the controllers reserve for
 * themselves, refusing a collision instead of silently overwriting one or
 * the other. A user label named `fiber-servo.owner` would otherwise make a
 * Container look owned by something it is not, which is exactly the kind of
 * silent-corruption bug a thrown error is worth here.
 */
function ownedLabels(
  templateLabels: Readonly<Record<string, string>> | undefined,
  owner: string,
  generation: string,
): Record<string, string> {
  for (const reserved of [OWNER_LABEL, GENERATION_LABEL]) {
    if (templateLabels && reserved in templateLabels) {
      throw new Error(
        `fiber-servo: label "${reserved}" is reserved for controller bookkeeping and cannot be set on a Container template`,
      );
    }
  }
  return { ...templateLabels, [OWNER_LABEL]: owner, [GENERATION_LABEL]: generation };
}

/**
 * "Keep `replicas` Containers of this template alive" becomes exactly
 * `replicas` `ContainerSpec`s, named `${replicaSet.name}-0`, `-1`, ...
 * `-(replicas-1)`.
 *
 * Names are deterministic, not just unique, so scaling 3 -> 5 mounts only
 * `-3` and `-4` and leaves `-0..-2` untouched — the same property decision 4
 * gives `<Deployment>`'s index-keyed replicas today, moved from a React key
 * to a container name because there is no fiber here to key.
 *
 * This function does not look at `observed` — it is accepted only so every
 * controller shares one call shape, `(spec, observed) => resources`. Whether
 * a container is actually alive is irrelevant to what the *desired* set is:
 * a dead container still belongs in it, same as before it died. PLAN.md says
 * this precisely — "the JSX and the fiber props have not changed" when a
 * container dies, so this function must not change its answer either.
 * Noticing that `foo-1` is dead and doing something about it is the runtime
 * adapter's job, once `serve.ts` hands it a Compose model built from this
 * function's output; this function's only job is to keep saying "there
 * should be 3" regardless of how many currently answer.
 */
export function expandReplicaSet(spec: ReplicaSetSpec, observed: ObservedState): ContainerSpec[] {
  void observed; // intentionally unread — see the doc comment above
  if (!Number.isInteger(spec.replicas) || spec.replicas < 0) {
    throw new Error(`fiber-servo: ReplicaSet "${spec.name}" replicas must be a non-negative integer`);
  }
  const labels = ownedLabels(spec.template.labels, spec.name, digest(spec.template));
  const containers: ContainerSpec[] = [];
  for (let i = 0; i < spec.replicas; i++) {
    containers.push({ ...spec.template, name: `${spec.name}-${i}`, labels });
  }
  return containers;
}

// ---- Deployment ---------------------------------------------------------

/**
 * `digest()` always renders as exactly 8 lowercase hex characters (32-bit
 * FNV-1a, `padStart(8, '0')` — see resources.ts), so it can be recovered
 * from the end of `${deployment.name}-${digest}` without re-parsing the
 * deployment name, which may itself contain hyphens.
 */
const DIGEST_LENGTH = 8;

/**
 * Reconstruct a best-effort `ContainerTemplate` for an old generation from
 * its observed Containers, because `expandDeployment` is a pure function of
 * the *current* `DeploymentSpec` — a Deployment carries one template, not a
 * history of them, and this module keeps no state of its own between calls
 * (see the module doc comment). So the only place an old generation's shape
 * can still be read from is the Containers it already produced.
 *
 * `ObservedContainer` carries no full spec any more — only a `specDigest`,
 * an opaque hash — because under the Compose write path the response to any
 * spec difference is uniformly "remove this service, let it be recreated",
 * so nothing downstream ever needed to know *which* field moved, and the
 * full spec stopped being worth carrying in observed state at all. That
 * leaves `image` and `labels` as the only fields this function can recover
 * — not command, env, ports, resources or a readiness probe. That is enough
 * for this function's one job, draining a generation to zero: every
 * old-generation container this template could produce already exists, so
 * its content is only ever read again if the control loop needs to recreate
 * one that died mid-drain, in which case it comes back thinner than it
 * started. Carrying the real template forward instead would mean caching it
 * somewhere across calls, which is precisely the statefulness this module
 * trades away.
 */
function reconstructTemplate(containers: readonly ObservedContainer[]): ContainerTemplate {
  const [sample] = [...containers].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!sample) {
    throw new Error('fiber-servo: internal: reconstructTemplate called with no observed containers');
  }
  const { [OWNER_LABEL]: _owner, [GENERATION_LABEL]: _generation, ...labels } = sample.labels;
  return { image: sample.image ?? '', labels };
}

/** The oldest of a generation's Containers, by observation time — the best proxy available, since `ObservedContainer` records when it was last seen, not when it was created. */
function oldestObservedAt(containers: readonly ObservedContainer[]): number {
  return Math.min(...containers.map((c) => c.at));
}

/**
 * A Deployment becomes one ReplicaSet per template generation: `newRS` for
 * `spec.template` as it reads right now, and one `oldRS` per generation that
 * still has Containers running from an earlier apply. A generation's
 * identity is `digest(template)` (decision 4's naming discipline, extended:
 * an unchanged template keeps the same name, and therefore the same
 * ReplicaSet, for free; an edited one gets a new name and therefore a new
 * rollout instead of mutating Containers in place).
 *
 * Rollout math (PLAN.md "Deployment rollout semantics", step 8): let
 * `newReady` be the observed count of the new generation's Containers that
 * are `running`, `maxSurge` (default 1) the Containers allowed above
 * `replicas`, and `maxUnavailable` (default 0) the Containers allowed
 * missing below it.
 *
 *   newReplicas = min(replicas, newReady + maxSurge)
 *   oldBudget   = max(0, replicas - newReady - maxUnavailable)
 *
 * `oldBudget` is shared across every old generation, oldest first: each
 * takes as much of the remaining budget as it currently has Containers for
 * (an old generation only ever shrinks — this function never conjures a new
 * container for one), and what a generation does not take stays for the
 * next. Once `newReady >= replicas`, `oldBudget` is 0 and every old
 * generation is driven to zero, which is how a rollout finishes.
 *
 * Returned new-generation-first. An old generation is always returned, even
 * at 0 replicas — that 0 *is* the removal instruction, the one exception to
 * "never emit a 0-replica ReplicaSet": omitting the entry would say nothing
 * about a generation that currently has live Containers, while returning it
 * at 0 says plainly "this generation's share is now none." The new
 * generation has no such Containers-already-exist case to signal, so it is
 * simply left out when its own share is 0.
 */
export function expandDeployment(spec: DeploymentSpec, observed: ObservedState): ReplicaSetSpec[] {
  if (!Number.isInteger(spec.replicas) || spec.replicas < 0) {
    throw new Error(`fiber-servo: Deployment "${spec.name}" replicas must be a non-negative integer`);
  }
  const newGeneration = digest(spec.template);
  const maxSurge = spec.strategy?.maxSurge ?? 1;
  const maxUnavailable = spec.strategy?.maxUnavailable ?? 0;

  // Group this Deployment's own observed Containers by generation.
  // Containers without both labels are not ours (or predate controller
  // ownership entirely) and are ignored rather than guessed about.
  const byGeneration = new Map<string, ObservedContainer[]>();
  for (const container of observed.containers.values()) {
    if (container.labels[OWNER_LABEL] !== spec.name) continue;
    const generation = container.labels[GENERATION_LABEL];
    if (generation === undefined) continue;
    const bucket = byGeneration.get(generation);
    if (bucket) bucket.push(container);
    else byGeneration.set(generation, [container]);
  }

  const newReady = (byGeneration.get(newGeneration) ?? []).filter((c) => c.phase === 'running').length;
  const newReplicas = Math.min(spec.replicas, newReady + maxSurge);

  const result: ReplicaSetSpec[] = [];
  if (newReplicas > 0) {
    result.push({ name: `${spec.name}-${newGeneration}`, replicas: newReplicas, template: spec.template });
  }

  const oldGenerations = [...byGeneration.entries()]
    .filter(([generation]) => generation !== newGeneration)
    .sort(([, a], [, b]) => oldestObservedAt(a) - oldestObservedAt(b));

  let oldBudget = Math.max(0, spec.replicas - newReady - maxUnavailable);
  for (const [generation, containers] of oldGenerations) {
    const allocated = Math.min(containers.length, oldBudget);
    oldBudget -= allocated;
    result.push({
      name: `${spec.name}-${generation}`,
      replicas: allocated,
      template: reconstructTemplate(containers),
    });
  }
  return result;
}

// ---- Service ----------------------------------------------------------------

/** A Container currently matching a Service's selector, as an address to route to. */
export interface Endpoint {
  container: string;
  address: string;
  port: number;
}

/**
 * Resolve a Service's backends from observed state, not from anything React
 * committed. This is the crux of decision 16's replacement (PLAN.md,
 * "External exposure / Service"): a Service resource carries only a
 * `selector`; the set of Containers behind it is a live query every time
 * this runs, so a container's death changes the answer on the very next
 * call without anything upstream re-rendering.
 *
 * Addressed **by container name, not IP**: `ObservedContainer` (the fixed
 * runtime contract) has no IP field at all, because Compose owns the
 * network and gives every service DNS resolution under its own name —
 * `nerdctl compose` sets a container's `--hostname` to its service name, so
 * `web-0` resolves on the network the moment it exists. There is nothing
 * for this function to prefer an IP over; the container's name *is* its
 * routable address.
 *
 * Kept to `running` Containers matching `selector`, sorted by name so the
 * result — and therefore the proxy config built from it — does not reorder
 * itself, and does not churn, between two calls where the actual backend set
 * has not changed.
 */
export function serviceEndpoints(spec: ServiceSpec, observed: ObservedState): Endpoint[] {
  const port = spec.targetPort ?? spec.port;
  const endpoints: Endpoint[] = [];
  for (const container of observed.containers.values()) {
    if (container.phase !== 'running') continue;
    if (!selectorMatches(spec.selector, container.labels)) continue;
    endpoints.push({ container: container.name, address: container.name, port });
  }
  return endpoints.sort((a, b) => (a.container < b.container ? -1 : a.container > b.container ? 1 : 0));
}

const PROXY_IMAGE = 'docker.io/library/caddy:2-alpine';

/**
 * The Service's data plane: a single caddy container reverse-proxying
 * `:port` to every current endpoint. PLAN.md is explicit that this split
 * matters — "the Service is control plane; the proxy is data plane" — and
 * this function is deliberately the *only* place that decision lives. A
 * Service resource, `serviceEndpoints`, and every caller of this function
 * stay ignorant of caddy entirely; swapping the data plane for nftables or a
 * host userspace proxy (both named as options in PLAN.md) means rewriting
 * this one function and nothing else in the module.
 *
 * Returns `undefined` with no endpoints on purpose: a proxy pointed at
 * nothing would accept connections and then fail every one of them, which
 * is worse than a Service that simply is not reachable yet — callers should
 * read "no proxy container" as "no backends", not as an error.
 */
export function serviceProxyContainer(
  spec: ServiceSpec,
  endpoints: readonly Endpoint[],
): ContainerSpec | undefined {
  if (endpoints.length === 0) return undefined;
  const command = [
    'caddy',
    'reverse-proxy',
    '--from',
    `:${spec.port}`,
    ...endpoints.flatMap((e) => ['--to', `${e.address}:${e.port}`]),
  ];
  return {
    name: spec.name,
    image: PROXY_IMAGE,
    command,
    ports: [spec.port],
    network: spec.network,
    publish: spec.publish === undefined ? undefined : [{ host: spec.publish, target: spec.port }],
  };
}

// ---- the entry point ---------------------------------------------------------

/**
 * Run every controller over one desired-state snapshot. This is what the
 * control loop calls, once per tick: it walks `desired.resources` in tree
 * order and flattens management resources into the runtime resources that
 * should exist right now.
 *
 *   network              passes through unchanged
 *   container             passes through unchanged (already a runtime resource)
 *   replicaset -> expandReplicaSet                        -> Containers
 *   deployment -> expandDeployment -> (per ReplicaSet) expandReplicaSet -> Containers
 *   service    -> serviceEndpoints -> serviceProxyContainer (if any endpoints) -> a Container
 *
 * A Deployment's generated ReplicaSets are relabeled here rather than inside
 * `expandDeployment`: `expandReplicaSet` always stamps `OWNER_LABEL` as the
 * ReplicaSet's own name, which for a generated `${deployment}-${digest}`
 * name is not what "the Deployment name" (see the Labels rule on
 * `expandReplicaSet`) means. Relabeling after the fact keeps
 * `expandReplicaSet` trivial and ignorant of Deployments entirely, and keeps
 * this the one place that knows a generated ReplicaSet's owner is not its
 * own name.
 *
 * Not a diff: this is `DesiredState -> desired runtime resources`, matching
 * `DesiredState` itself (resources.ts) being a snapshot rather than an op
 * stream. Turning this output into a Compose Application Model and handing
 * it to `Runtime.apply` is `serve.ts`'s job, described but not built here.
 */
export function runControllers(
  desired: DesiredState,
  observed: ObservedState,
): { networks: NetworkSpec[]; containers: ContainerSpec[] } {
  const networks: NetworkSpec[] = [];
  const containers: ContainerSpec[] = [];
  // Tracks which resource produced each container name, purely so a
  // collision can name both offenders instead of just the name that lost
  // the race.
  const producedBy = new Map<string, string>();

  const addContainer = (container: ContainerSpec, from: string): void => {
    const existing = producedBy.get(container.name);
    if (existing !== undefined) {
      throw new Error(
        `fiber-servo: two resources both produce a container named "${container.name}" (${existing} and ${from})`,
      );
    }
    producedBy.set(container.name, from);
    containers.push(container);
  };

  for (const resource of desired.resources) {
    switch (resource.kind) {
      case 'network':
        networks.push(resource.spec);
        break;

      case 'container':
        addContainer(resource.spec, `container "${resource.name}"`);
        break;

      case 'replicaset':
        for (const container of expandReplicaSet(resource.spec, observed)) {
          addContainer(container, `replicaset "${resource.name}"`);
        }
        break;

      case 'deployment':
        for (const replicaSet of expandDeployment(resource.spec, observed)) {
          // See the doc comment above: `expandReplicaSet` names the owner
          // after `replicaSet.name`, which is `${deployment}-${digest}`, so
          // it is corrected here to the Deployment's own name. The
          // generation label it stamped is already right — it recomputed
          // `digest(replicaSet.template)`, which for the new generation
          // *is* `spec.template` and for an old one is what named this very
          // ReplicaSet in the first place — but pulling it straight from
          // the name (see `DIGEST_LENGTH`) avoids trusting a second
          // recomputation to agree with the first.
          const generation = replicaSet.name.slice(-DIGEST_LENGTH);
          for (const container of expandReplicaSet(replicaSet, observed)) {
            addContainer(
              {
                ...container,
                labels: {
                  ...container.labels,
                  [OWNER_LABEL]: resource.spec.name,
                  [GENERATION_LABEL]: generation,
                },
              },
              `deployment "${resource.name}"`,
            );
          }
        }
        break;

      case 'service': {
        const endpoints = serviceEndpoints(resource.spec, observed);
        const proxy = serviceProxyContainer(resource.spec, endpoints);
        if (proxy) addContainer(proxy, `service "${resource.name}"`);
        break;
      }
    }
  }

  return { networks, containers };
}
