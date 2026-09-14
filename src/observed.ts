/**
 * Observed state lives here, outside the fiber tree (design rule #3, PLAN.md
 * "Observed state").
 *
 * The one idea this file exists to protect: a container dying is a change to
 * *reality*, never a change to what we *want*. If a ReplicaSet asks for three
 * containers and one disappears, the JSX did not change and no fiber prop
 * should be made to change either — that would fake a React update just to
 * get `commitUpdate` to fire, which is exactly the trap PLAN.md warns
 * against. Instead the disappearance is recorded here, and it is a
 * *controller* (ReplicaSet, Service, ...) that reads this store, compares
 * desired against observed, and decides what to do about the difference.
 * `ObservedStore` is that recording surface: a plain observable map, with no
 * React and no process spawning in it.
 *
 * The store is flat — keyed by container name, with no Pod wrapping it —
 * because there is no Pod any more. A container is the unit of everything, so
 * this file has exactly one level of nesting less than the version it
 * replaces: `Map<name, ObservedContainer>` instead of
 * `Map<podName, ObservedPod>` with a container list inside each.
 *
 * Writers: a `Runtime` adapter, translating `nerdctl compose events` / a CRI
 * stream / a poll into `RuntimeEvent`s via `applyRuntimeEvent`, plus (on a
 * real adapter) a readiness prober amending `ready`. Readers: controllers,
 * through `subscribe`, or a `useSyncExternalStore` wrapper one layer up.
 *
 * Every mutation produces a fresh, frozen `ObservedState` with `revision` one
 * higher and notifies subscribers synchronously, so a reader can use `!==` on
 * `snapshot()` to detect change cheaply — the same discipline this file has
 * always used, just with one less layer to freeze.
 */
import type {
  ContainerPatch,
  ObservedContainer,
  ObservedState,
  ObservedStore,
  RuntimeEvent,
} from './runtime/types.js';

/**
 * A container is ready when it is `running` and does not *actively* report
 * unready. A container without a readiness probe never reports `ready` at
 * all (the field stays `undefined`), and such a container must not be held
 * to a standard it never promised — so only an explicit `ready === false`
 * counts against readiness.
 */
export function isReady(container: ObservedContainer | undefined): boolean {
  if (!container || container.phase !== 'running') return false;
  return container.ready !== false;
}

/** Fold one RuntimeEvent from an adapter into the store. */
export function applyRuntimeEvent(store: ObservedStore, event: RuntimeEvent): void {
  switch (event.type) {
    case 'container':
      store.set(event.container);
      break;
    case 'container-removed':
      store.remove(event.name);
      break;
    case 'resync':
      store.reset(event.containers);
      break;
  }
}

function freezeContainer(container: ObservedContainer): ObservedContainer {
  return Object.freeze({
    ...container,
    networks: Object.freeze([...container.networks]),
    labels: Object.freeze({ ...container.labels }),
  });
}

export function createObservedStore(now: () => number = Date.now): ObservedStore {
  const containers = new Map<string, ObservedContainer>();
  const listeners = new Set<() => void>();
  let revision = 0;

  function buildSnapshot(): ObservedState {
    // Copy the live map rather than handing it out: the store keeps
    // mutating `containers` after this point, and a reader holding an older
    // snapshot must keep seeing the state as of that snapshot.
    return Object.freeze({ containers: new Map(containers), revision });
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

    get(name) {
      return containers.get(name);
    },

    set(container) {
      containers.set(container.name, freezeContainer({ ...container, at: now() }));
      commit();
    },

    patch(name, patch: ContainerPatch) {
      const existing = containers.get(name);
      // A stray event about a container the runtime never reported must not
      // conjure one into existence — only `set` (a real observation) creates
      // one. This mirrors the old store's rule for `patchPod`/`patchContainer`.
      if (!existing) return;
      containers.set(
        name,
        freezeContainer({
          ...existing,
          ...patch,
          networks: patch.networks ?? existing.networks,
          labels: patch.labels ?? existing.labels,
          at: now(),
        }),
      );
      commit();
    },

    remove(name) {
      if (containers.delete(name)) commit();
    },

    reset(next) {
      containers.clear();
      for (const container of next) containers.set(container.name, freezeContainer(container));
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
