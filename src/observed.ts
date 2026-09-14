/**
 * Observed state lives here, outside the fiber tree (design rule #3, PLAN.md
 * "Observed state").
 *
 * The one idea this file exists to protect: a Pod dying is a change to
 * *reality*, never a change to what we *want*. If a ReplicaSet asks for three
 * replicas and one Pod disappears, the JSX did not change and no fiber prop
 * should be made to change either — that would fake a React update just to
 * get `commitUpdate` to fire, which is exactly the trap PLAN.md warns against.
 * Instead the disappearance is recorded here, and it is a *controller*
 * (ReplicaSet, Service, ...) that reads this store, compares desired against
 * observed, and decides to create a replacement. `ObservedStore` is that
 * recording surface: a plain observable map, with no React and no process
 * spawning in it.
 *
 * Writers: a `Runtime` adapter, translating `nerdctl events` / a CRI stream /
 * a poll into `RuntimeEvent`s via `applyRuntimeEvent`, plus a readiness
 * prober amending `ready`. Readers: controllers, through `subscribe` or a
 * `useSyncExternalStore` wrapper one layer up.
 *
 * Every mutation produces a fresh, frozen `ObservedState` with `revision` one
 * higher and notifies subscribers synchronously, so a reader can use `!==` on
 * `snapshot()` to detect change cheaply — the same discipline `status.ts`
 * uses, just one level up: a Pod with its Containers instead of one bare
 * container id.
 */
import type {
  ContainerPatch,
  ObservedContainer,
  ObservedNetwork,
  ObservedPod,
  ObservedState,
  ObservedStore,
  PodPatch,
  PodPhase,
  RuntimeEvent,
} from './runtime/types.js';

/**
 * A Pod is running when it has containers and all of them are; exited when
 * it has some and none are. Anything else — no containers yet, or a mix of
 * phases mid-transition — is `pending`: the sandbox exists but has not
 * settled into either extreme. This function never returns `unknown`: that
 * value is reserved for a Pod that has not been observed at all, which is a
 * question about the *Pod*, not something derivable from a container list.
 */
export function derivePodPhase(containers: readonly ObservedContainer[]): PodPhase {
  if (containers.length === 0) return 'pending';
  if (containers.every((c) => c.phase === 'running')) return 'running';
  if (containers.every((c) => c.phase === 'exited')) return 'exited';
  return 'pending';
}

/**
 * A Pod is ready when it is `running` and none of its containers is
 * *actively* unready. A container without a readiness probe never reports
 * `ready` at all (the field stays `undefined`), and such a container must
 * not hold up the Pod forever waiting on a signal it will never send — so
 * only an explicit `ready === false` counts against readiness.
 */
export function isPodReady(pod: ObservedPod | undefined): boolean {
  if (!pod || pod.phase !== 'running') return false;
  return pod.containers.every((c) => c.ready !== false);
}

/** Fold one RuntimeEvent from an adapter into the store. */
export function applyRuntimeEvent(store: ObservedStore, event: RuntimeEvent): void {
  switch (event.type) {
    case 'pod':
      store.setPod(event.pod);
      break;
    case 'pod-removed':
      store.removePod(event.name);
      break;
    case 'container':
      store.patchContainer(event.pod, event.container.name, event.container);
      break;
    case 'resync':
      store.reset(event.state);
      break;
  }
}

function freezeContainer(container: ObservedContainer): ObservedContainer {
  return Object.freeze({ ...container });
}

/** Deep-freeze a whole Pod observation: its label map and every container. */
function freezePod(pod: ObservedPod): ObservedPod {
  return Object.freeze({
    ...pod,
    labels: Object.freeze({ ...pod.labels }),
    containers: Object.freeze(pod.containers.map(freezeContainer)),
  });
}

function freezeNetwork(network: ObservedNetwork): ObservedNetwork {
  return Object.freeze({ ...network });
}

export function createObservedStore(now: () => number = Date.now): ObservedStore {
  const pods = new Map<string, ObservedPod>();
  const networks = new Map<string, ObservedNetwork>();
  const listeners = new Set<() => void>();
  let revision = 0;

  function buildSnapshot(): ObservedState {
    // Copy the live maps rather than handing them out: the store keeps
    // mutating `pods`/`networks` after this point, and a reader holding an
    // older snapshot must keep seeing the state as of that snapshot.
    return Object.freeze({ pods: new Map(pods), networks: new Map(networks), revision });
  }

  let current = buildSnapshot();

  function commit(): void {
    revision += 1;
    current = buildSnapshot();
    for (const listener of [...listeners]) listener();
  }

  return {
    snapshot() {
      return current;
    },

    getPod(name) {
      return pods.get(name);
    },

    setPod(pod) {
      pods.set(pod.name, freezePod(pod));
      commit();
    },

    patchPod(name, patch: PodPatch) {
      const existing = pods.get(name);
      // A stray event about a Pod the runtime never reported must not
      // conjure one into existence — only setPod (a real observation)
      // creates a Pod.
      if (!existing) return;
      pods.set(
        name,
        Object.freeze({
          ...existing,
          ...patch,
          labels: patch.labels ? Object.freeze({ ...patch.labels }) : existing.labels,
          containers: existing.containers, // PodPatch never touches containers
        }),
      );
      commit();
    },

    patchContainer(podName, containerName, patch: ContainerPatch) {
      const pod = pods.get(podName);
      // Same non-conjuring rule as patchPod: an unknown Pod stays unknown.
      if (!pod) return;

      const index = pod.containers.findIndex((c) => c.name === containerName);
      let containers: readonly ObservedContainer[];
      if (index === -1) {
        // Asymmetric with patchPod on purpose: a sandbox is observed before
        // the containers running inside it, so the first word about a
        // container can arrive for a Pod that is already known but does not
        // list it yet. Only a wholly unknown *Pod* is rejected above; an
        // unknown *container* in a known Pod is simply added.
        containers = [
          ...pod.containers,
          freezeContainer({ name: containerName, phase: 'unknown', ...patch }),
        ];
      } else {
        const next = pod.containers.slice();
        // Safe: `index` came from findIndex above and is not -1 here.
        next[index] = freezeContainer({ ...pod.containers[index]!, ...patch });
        containers = next;
      }

      // Precedence: a Pod's `phase` can be set explicitly by setPod or by a
      // patchPod call that includes it (an adapter that knows something the
      // container list does not, e.g. the sandbox just vanished). That
      // explicit value stands only until the *next* container-level
      // observation — patchContainer always re-derives from the current
      // container list, because a fresh per-container observation is by
      // definition newer information about those containers than whatever
      // set the Pod's phase before it.
      pods.set(
        podName,
        Object.freeze({
          ...pod,
          phase: derivePodPhase(containers),
          containers: Object.freeze(containers),
          at: now(),
        }),
      );
      commit();
    },

    removePod(name) {
      if (pods.delete(name)) commit();
    },

    setNetwork(network) {
      networks.set(network.name, freezeNetwork(network));
      commit();
    },

    removeNetwork(name) {
      if (networks.delete(name)) commit();
    },

    reset(state) {
      pods.clear();
      for (const [name, pod] of state.pods) pods.set(name, freezePod(pod));
      networks.clear();
      for (const [name, network] of state.networks) networks.set(name, freezeNetwork(network));
      commit();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
