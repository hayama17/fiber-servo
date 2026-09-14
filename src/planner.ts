/**
 * The planner: desired state in, actions out.
 *
 * This file owns the immutability model — the decision of whether a changed
 * field means nothing, an update in place, or a replacement. It is the reason
 * no layer above it ever says `stop`, `delete` or `start`: those are not
 * decisions React or a controller is equipped to make, because making them
 * correctly needs to know what the runtime already holds.
 *
 * It is a pure function, and the comparison it makes is worth being precise
 * about. It does *not* compare the desired spec against what is running —
 * an observation tells you a container is up, not what was asked for, so it
 * cannot tell a cpu change from an image change. It compares the desired spec
 * against **the spec the Pod was created from**, which the adapter records on
 * the Pod itself (see `ObservedPod.spec` and decision 26). Desired versus
 * recorded answers "which field changed"; observed phase answers "is it still
 * alive". The planner needs both, and they are different questions.
 */
import {
  digest,
  specValueEquals,
  type ContainerSpec,
  type NetworkSpec,
  type PodSpec,
  type ResourceLimits,
} from './resources.js';
import type { ObservedPod, ObservedState } from './runtime/types.js';

// ---- actions ---------------------------------------------------------------

/**
 * What the control loop should ask the runtime to do.
 *
 * `because` lists the spec fields that forced the decision, so a plan can
 * explain itself: `replace-pod api-0 because [network]` is a sentence a
 * reader can act on, where a bare `replace-pod api-0` is not.
 */
export type Action =
  | { type: 'create-network'; spec: NetworkSpec }
  | { type: 'remove-network'; name: string }
  | { type: 'replace-network'; name: string; spec: NetworkSpec; because: readonly string[] }
  | { type: 'create-pod'; spec: PodSpec }
  | { type: 'remove-pod'; name: string }
  | { type: 'replace-pod'; name: string; spec: PodSpec; because: readonly string[] }
  | { type: 'create-container'; pod: string; spec: ContainerSpec }
  | { type: 'remove-container'; pod: string; name: string }
  | { type: 'replace-container'; pod: string; spec: ContainerSpec; because: readonly string[] }
  | { type: 'update-container-resources'; pod: string; name: string; resources: ResourceLimits };

// ---- what is mutable, and what is not --------------------------------------

/**
 * The only field of a container a runtime can change without replacing the
 * process behind it. Everything else — image, command, environment, root
 * filesystem — is baked in at creation.
 */
const CONTAINER_MUTABLE = ['resources'] as const;

const CONTAINER_IMMUTABLE = ['image', 'command', 'env', 'ports', 'readiness'] as const;

/**
 * Sandbox properties. Changing any of them replaces the Pod, because they are
 * decided when the network namespace is created.
 *
 * `labels` sits here for a weaker reason than the others: no adapter we have
 * can relabel a live sandbox. It is not conceptually immutable, and if an
 * adapter ever gains `updatePodLabels` this is the line to move.
 */
const POD_IMMUTABLE = ['network', 'publish', 'labels'] as const;

function changedFields<T>(prev: T, next: T, keys: readonly (keyof T & string)[]): string[] {
  return keys.filter((key) => !specValueEquals(prev[key], next[key]));
}

// ---- one pod ---------------------------------------------------------------

/**
 * Actions for a single Pod. `observed` undefined means it does not exist yet.
 *
 * Order within a Pod matters: the Pod-level verdict is decided first, because
 * replacing the sandbox makes every container-level action moot.
 */
export function planPod(desired: PodSpec, observed: ObservedPod | undefined): Action[] {
  if (observed === undefined) return [{ type: 'create-pod', spec: desired }];

  // A Pod that died needs the same treatment as one whose spec changed, and it
  // needs it regardless of what its spec says. This single line is where
  // "controllers reconcile runtime resources" stops being a slogan: nothing
  // about the desired state changed, and yet there is work to do.
  if (observed.phase === 'exited') {
    return [{ type: 'replace-pod', name: desired.name, spec: desired, because: ['phase'] }];
  }

  const recorded = observed.spec;
  if (recorded === undefined) {
    // We have no record of creating this Pod with a given spec.
    if (observed.specDigest === undefined) {
      // Not ours at all. Adopt it rather than fight it — deleting a container
      // we cannot prove we made is the one mistake with no undo.
      return [];
    }
    // Ours, but from a version that recorded only a digest. We can tell that
    // something differs, never which field, so we must not guess at an
    // in-place update.
    return observed.specDigest === digest(desired)
      ? []
      : [{ type: 'replace-pod', name: desired.name, spec: desired, because: ['spec'] }];
  }

  const sandboxChanged = changedFields(recorded, desired, POD_IMMUTABLE);
  if (sandboxChanged.length > 0) {
    return [{ type: 'replace-pod', name: desired.name, spec: desired, because: sandboxChanged }];
  }

  return planContainers(desired, recorded);
}

/** The container set of a Pod whose sandbox is already correct. */
function planContainers(desired: PodSpec, recorded: PodSpec): Action[] {
  const actions: Action[] = [];
  const recordedByName = new Map(recorded.containers.map((c) => [c.name, c]));

  for (const next of desired.containers) {
    const prev = recordedByName.get(next.name);
    if (prev === undefined) {
      actions.push({ type: 'create-container', pod: desired.name, spec: next });
      continue;
    }
    const immutable = changedFields(prev, next, CONTAINER_IMMUTABLE);
    if (immutable.length > 0) {
      actions.push({ type: 'replace-container', pod: desired.name, spec: next, because: immutable });
      continue;
    }
    // Nothing immutable moved, so whatever is left can be applied in place.
    // This is the only branch in the entire system that mutates a live
    // resource rather than replacing it.
    const mutable = changedFields(prev, next, CONTAINER_MUTABLE);
    if (mutable.length > 0) {
      actions.push({
        type: 'update-container-resources',
        pod: desired.name,
        name: next.name,
        resources: next.resources ?? {},
      });
    }
  }

  const desiredNames = new Set(desired.containers.map((c) => c.name));
  for (const prev of recorded.containers) {
    if (!desiredNames.has(prev.name)) {
      actions.push({ type: 'remove-container', pod: desired.name, name: prev.name });
    }
  }

  return actions;
}

// ---- one network -----------------------------------------------------------

function planNetwork(
  desired: NetworkSpec,
  observed: { name: string; subnet?: string } | undefined,
): Action[] {
  if (observed === undefined) return [{ type: 'create-network', spec: desired }];
  // Observation of a network is thin — a name and a subnet is all a runtime
  // reliably reports — so the subnet is all there is to compare. A label
  // change is invisible here, which is acceptable: nothing routes on it.
  // A desired spec that does not name a subnet accepts whatever it was given.
  if (desired.subnet !== undefined && desired.subnet !== observed.subnet) {
    return [{ type: 'replace-network', name: desired.name, spec: desired, because: ['subnet'] }];
  }
  return [];
}

// ---- the whole reconcile ---------------------------------------------------

/**
 * Everything that must happen for reality to match `desired`.
 *
 * The ordering is the interesting part, and it is fixed rather than clever:
 *
 *   1. networks created and replaced first, so a Pod always has the network it
 *      references by the time it is created;
 *   2. pod-level work next, creations before removals, so a rolling
 *      replacement never dips below capacity longer than it must;
 *   3. networks removed last, after the Pods that were attached to them are
 *      gone — removing a network out from under a live Pod is how you get a
 *      runtime that refuses and a reconcile that never converges.
 */
export function planAll(
  desired: { networks: readonly NetworkSpec[]; pods: readonly PodSpec[] },
  observed: ObservedState,
): Action[] {
  const networkCreates: Action[] = [];
  const networkRemovals: Action[] = [];
  const podActions: Action[] = [];
  const podRemovals: Action[] = [];

  for (const network of desired.networks) {
    networkCreates.push(...planNetwork(network, observed.networks.get(network.name)));
  }

  const desiredNetworks = new Set(desired.networks.map((n) => n.name));
  for (const name of observed.networks.keys()) {
    if (!desiredNetworks.has(name)) networkRemovals.push({ type: 'remove-network', name });
  }

  for (const pod of desired.pods) {
    podActions.push(...planPod(pod, observed.pods.get(pod.name)));
  }

  const desiredPods = new Set(desired.pods.map((p) => p.name));
  for (const [name, pod] of observed.pods) {
    if (desiredPods.has(name)) continue;
    // Same caution as in `planPod`: a Pod with no sign of our ownership is
    // left alone. fiber-servo shares a machine; it does not own it.
    if (pod.spec === undefined && pod.specDigest === undefined) continue;
    podRemovals.push({ type: 'remove-pod', name });
  }

  return [...networkCreates, ...podActions, ...podRemovals, ...networkRemovals];
}

// ---- rendering -------------------------------------------------------------

/** One line per action, for `fiber-servo plan`, logs and test failure messages. */
export function formatAction(action: Action): string {
  switch (action.type) {
    case 'create-network':
      return `create-network ${action.spec.name}`;
    case 'remove-network':
      return `remove-network ${action.name}`;
    case 'replace-network':
      return `replace-network ${action.name} because [${action.because.join(',')}]`;
    case 'create-pod':
      return `create-pod ${action.spec.name}`;
    case 'remove-pod':
      return `remove-pod ${action.name}`;
    case 'replace-pod':
      return `replace-pod ${action.name} because [${action.because.join(',')}]`;
    case 'create-container':
      return `create-container ${action.pod}/${action.spec.name} image=${action.spec.image}`;
    case 'remove-container':
      return `remove-container ${action.pod}/${action.name}`;
    case 'replace-container':
      return `replace-container ${action.pod}/${action.spec.name} because [${action.because.join(',')}]`;
    case 'update-container-resources':
      return `update-container-resources ${action.pod}/${action.name} ${formatLimits(action.resources)}`;
  }
}

function formatLimits(resources: ResourceLimits): string {
  return (
    [
      resources.cpu !== undefined ? `cpu=${resources.cpu}` : undefined,
      resources.memory !== undefined ? `memory=${resources.memory}` : undefined,
    ]
      .filter(Boolean)
      .join(' ') || 'cleared'
  );
}
