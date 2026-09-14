/**
 * The read path from observed state into the tree.
 *
 * These hooks let a component *read* what is actually running, so the desired
 * state it declares can depend on it — "don't declare the web Pod until the
 * database answers its probe". Reading is the whole of the contract.
 *
 * What used to live here and deliberately does not any more: `useSelfHeal`.
 * It watched for a container dying and answered by incrementing a restart
 * generation, which travelled down as a prop purely so that React would see a
 * changed value and emit a commit. That made a runtime failure look like a
 * change of intent. Replacing a dead Pod is now what the ReplicaSet controller
 * and the planner do, from observed state, without troubling React at all —
 * which is why a Pod dying no longer produces a single React render.
 */
import { createContext, use, useContext, useSyncExternalStore } from 'react';
import { createObservedStore, isPodReady } from './observed.js';
import type { ObservedPod, ObservedStore } from './runtime/types.js';

/** The observed state the enclosing root reads from. */
export const ObservedContext = createContext<ObservedStore>(createObservedStore());

export function useObserved(): ObservedStore {
  return useContext(ObservedContext);
}

/** The current observation of one Pod, or undefined when the runtime has never reported it. */
export function usePod(name: string): ObservedPod | undefined {
  const store = useObserved();
  return useSyncExternalStore(store.subscribe, () => store.getPod(name));
}

// ---- dependency ordering ---------------------------------------------------

/**
 * What a dependent waits for. `running` is the runtime having started the
 * Pod's containers; `ready` additionally needs every readiness probe to have
 * passed.
 */
export type ReadyCondition = 'running' | 'ready';

export function podSatisfies(pod: ObservedPod | undefined, until: ReadyCondition): boolean {
  if (pod === undefined) return false;
  return until === 'running' ? pod.phase === 'running' : isPodReady(pod);
}

interface ReadyThenable {
  status: 'pending' | 'fulfilled';
  value?: ObservedPod;
  then(onFulfilled: (value: ObservedPod) => void, onRejected?: (reason: unknown) => void): void;
}

const readyCache = new WeakMap<ObservedStore, Map<string, ReadyThenable>>();

/**
 * A thenable that settles the first time `name` satisfies `until`, and stays
 * settled. Dependency ordering is about startup, not liveness: once the
 * database has come up, the web Pod's desired state does not stop being
 * desired because the database later restarts — the planner will bring the
 * database back, and unmounting its dependents in the meantime would turn a
 * blip into an outage. React's `use` reads `status` synchronously, so a Pod
 * that is already up never suspends.
 */
export function readyThenable(
  store: ObservedStore,
  name: string,
  until: ReadyCondition = 'running',
): ReadyThenable {
  let perStore = readyCache.get(store);
  if (!perStore) readyCache.set(store, (perStore = new Map()));
  const key = `${until}:${name}`;
  const cached = perStore.get(key);
  if (cached) return cached;

  const listeners: ((value: ObservedPod) => void)[] = [];
  const thenable: ReadyThenable = {
    status: 'pending',
    then(onFulfilled) {
      if (thenable.status === 'fulfilled') onFulfilled(thenable.value!);
      else listeners.push(onFulfilled);
    },
  };
  const settle = (pod: ObservedPod): void => {
    thenable.status = 'fulfilled';
    thenable.value = pod;
    for (const l of listeners.splice(0)) l(pod);
  };
  const now = store.getPod(name);
  if (podSatisfies(now, until)) settle(now!);
  else {
    const off = store.subscribe(() => {
      const pod = store.getPod(name);
      if (!podSatisfies(pod, until)) return;
      off();
      settle(pod!);
    });
  }
  perStore.set(key, thenable);
  return thenable;
}

/**
 * Suspend until every listed Pod satisfies `until` once.
 * Needs a <Suspense> boundary above; <Ready> provides one.
 */
export function useReady(names: string | readonly string[], until: ReadyCondition = 'running'): void {
  const store = useObserved();
  for (const name of typeof names === 'string' ? [names] : names) {
    // React's Usable type wants a Promise shape; a status-tracked thenable is what `use` actually reads.
    use(readyThenable(store, name, until) as unknown as Promise<ObservedPod>);
  }
}
