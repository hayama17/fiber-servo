/**
 * Runtime status lives here, outside the fiber tree (design rule #1).
 *
 * Writers: whatever watches the runtime (containerd events, a readiness
 * prober, a test, the dummy runtime). Readers: components, through
 * `useSyncExternalStore`. Nothing in the hostConfig touches this store.
 *
 * Every `set` is one event and bumps `seq`, even if the state is unchanged:
 * two `dead` events are two deaths. Snapshots are immutable objects so
 * `useSyncExternalStore` can compare them by identity.
 */

export type ContainerState = 'unknown' | 'running' | 'dead';

export interface ContainerStatus {
  readonly state: ContainerState;
  /** Monotonic per store; identifies the event that produced this snapshot. */
  readonly seq: number;
  /** `Date.now()` when the event was recorded. */
  readonly at: number;
  readonly exitCode?: number;
  readonly reason?: string;
  /** Set by a readiness prober once the container answers its probe. Cleared by the next `set`. */
  readonly ready?: boolean;
}

export interface StatusDetail {
  exitCode?: number;
  reason?: string;
  ready?: boolean;
}

export interface StatusStore {
  /** Snapshot for `id`; a shared `unknown` snapshot when nothing was recorded. */
  get(id: string): ContainerStatus;
  /** Record a lifecycle event for `id`. Replaces the snapshot; notifies subscribers synchronously. */
  set(id: string, state: ContainerState, detail?: StatusDetail): ContainerStatus;
  /**
   * Amend the current snapshot for `id` without changing its state (a
   * readiness result, for instance). No-op for unknown ids, so a prober
   * cannot resurrect a container the watcher has already forgotten.
   */
  mark(id: string, detail: StatusDetail): ContainerStatus | undefined;
  /** Forget `id` (the container is gone). Readers see `unknown` again. */
  remove(id: string): void;
  subscribe(listener: () => void): () => void;
  /** Every recorded id and its latest snapshot. */
  entries(): ReadonlyMap<string, ContainerStatus>;
}

export const UNKNOWN_STATUS: ContainerStatus = Object.freeze({ state: 'unknown', seq: 0, at: 0 });

export function createStatusStore(now: () => number = Date.now): StatusStore {
  const statuses = new Map<string, ContainerStatus>();
  const listeners = new Set<() => void>();
  let seq = 0;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function record(id: string, status: ContainerStatus): ContainerStatus {
    statuses.set(id, status);
    notify();
    return status;
  }

  return {
    get(id) {
      return statuses.get(id) ?? UNKNOWN_STATUS;
    },
    set(id, state, detail) {
      seq += 1;
      return record(id, Object.freeze({ state, seq, at: now(), ...detail }));
    },
    mark(id, detail) {
      const current = statuses.get(id);
      if (!current) return undefined;
      seq += 1;
      // `at` stays the lifecycle event's time: a readiness mark does not restart clocks that key on it.
      return record(id, Object.freeze({ ...current, ...detail, seq }));
    },
    remove(id) {
      if (statuses.delete(id)) notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    entries() {
      return statuses;
    },
  };
}
