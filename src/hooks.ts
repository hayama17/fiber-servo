/**
 * The read path from observed state into the tree.
 *
 * These hooks let a component *read* what is actually running, so the desired
 * state it declares can depend on it — "don't declare the web container until
 * the database answers its probe". Reading is the whole of the contract.
 *
 * Controllers use these hooks to turn observations into runtime resources.
 * Runtime events are inputs to React; they are never rewritten as fake props
 * or restart generations.
 *
 * Restart admission follows the same read path. `useRestartAdmission` keeps a
 * per-Container failure record and renders the resource only when its backoff
 * window admits it. The timer that wakes the hook is a plain effect; it does
 * not perform runtime I/O.
 */
import { createContext, use, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createObservedStore, isReady } from './observed.js';
import {
  admitRestart,
  DEFAULT_RESTART_POLICY,
  type RestartContextValue,
  type RestartRecord,
} from './restart.js';
import type { ContainerSpec } from './resources.js';
import type { ObservedContainer, ObservedStore } from './runtime/types.js';

/** The observed state the enclosing root reads from. */
export const ObservedContext = createContext<ObservedStore>(createObservedStore());

/** Restart settings for the root. Timers and logging stay outside render. */
export const RestartContext = createContext<RestartContextValue>({
  policy: DEFAULT_RESTART_POLICY,
  now: Date.now,
});

export function useObserved(): ObservedStore {
  return useContext(ObservedContext);
}

/**
 * Decide whether a runtime Container is admitted in this render.
 *
 * A crashed container is rendered once to request its first replacement. If
 * it crashes again before the backoff expires, the component renders null and
 * a timer schedules the next React update. The runtime never appears in this
 * hook; it only reads the observed store.
 */
export function useRestartAdmission(spec: ContainerSpec): boolean {
  const store = useObserved();
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const context = useContext(RestartContext);
  const [, rerender] = useState(0);
  const recordRef = useRef<RestartRecord | undefined>(undefined);
  const result = admitRestart(
    recordRef.current,
    spec,
    snapshot.containers.get(spec.name)?.phase ?? 'absent',
    context,
  );
  recordRef.current = result.record;

  useEffect(() => {
    if (result.gaveUp) context.onGiveUp?.(spec.name, context.policy.maxRestarts);
    if (result.retryAt === undefined) return;
    const delay = Math.max(0, result.retryAt - context.now());
    const timer = setTimeout(() => rerender((value) => value + 1), delay);
    timer.unref?.();
    return () => clearTimeout(timer);
  }, [context, result.gaveUp, result.retryAt, spec.name]);

  return result.admitted;
}

/** The current observation of one container, or undefined when the runtime has never reported it. */
export function useContainer(name: string): ObservedContainer | undefined {
  const store = useObserved();
  return useSyncExternalStore(store.subscribe, () => store.get(name));
}

// ---- dependency ordering ---------------------------------------------------

/**
 * What a dependent waits for. `running` is the runtime having started the
 * container; `ready` additionally needs its readiness probe to have passed.
 */
export type ReadyCondition = 'running' | 'ready';

export function containerSatisfies(container: ObservedContainer | undefined, until: ReadyCondition): boolean {
  if (container === undefined) return false;
  return until === 'running' ? container.phase === 'running' : isReady(container);
}

interface ReadyThenable {
  status: 'pending' | 'fulfilled';
  value?: ObservedContainer;
  then(onFulfilled: (value: ObservedContainer) => void, onRejected?: (reason: unknown) => void): void;
}

const readyCache = new WeakMap<ObservedStore, Map<string, ReadyThenable>>();

/**
 * A thenable that settles the first time `name` satisfies `until`, and stays
 * settled. Dependency ordering is about startup, not liveness: once the
 * database has come up, the web container's desired state does not stop
 * being desired because the database later restarts — the control loop will
 * bring the database back, and unmounting its dependents in the meantime
 * would turn a blip into an outage. React's `use` reads `status`
 * synchronously, so a container that is already up never suspends.
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

  const listeners: ((value: ObservedContainer) => void)[] = [];
  const thenable: ReadyThenable = {
    status: 'pending',
    then(onFulfilled) {
      if (thenable.status === 'fulfilled') onFulfilled(thenable.value!);
      else listeners.push(onFulfilled);
    },
  };
  const settle = (container: ObservedContainer): void => {
    thenable.status = 'fulfilled';
    thenable.value = container;
    for (const l of listeners.splice(0)) l(container);
  };
  const now = store.get(name);
  if (containerSatisfies(now, until)) settle(now!);
  else {
    const off = store.subscribe(() => {
      const container = store.get(name);
      if (!containerSatisfies(container, until)) return;
      off();
      settle(container!);
    });
  }
  perStore.set(key, thenable);
  return thenable;
}

/**
 * Suspend until every listed container satisfies `until` once.
 * Needs a <Suspense> boundary above; <Ready> provides one.
 */
export function useReady(names: string | readonly string[], until: ReadyCondition = 'running'): void {
  const store = useObserved();
  for (const name of typeof names === 'string' ? [names] : names) {
    // React's Usable type wants a Promise shape; a status-tracked thenable is what `use` actually reads.
    use(readyThenable(store, name, until) as unknown as Promise<ObservedContainer>);
  }
}
