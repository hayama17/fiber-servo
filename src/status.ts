/**
 * Runtime status lives here, outside the fiber tree (design rule #1).
 *
 * Writers: whatever watches the runtime (docker events, a test, the dummy
 * runtime). Readers: components, through `useSyncExternalStore`. Nothing in
 * the hostConfig touches this store.
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
}

export interface StatusDetail {
  exitCode?: number;
  reason?: string;
}

export interface StatusStore {
  /** Snapshot for `id`; a shared `unknown` snapshot when nothing was recorded. */
  get(id: string): ContainerStatus;
  /** Record an event for `id`. Notifies subscribers synchronously. */
  set(id: string, state: ContainerState, detail?: StatusDetail): ContainerStatus;
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

  return {
    get(id) {
      return statuses.get(id) ?? UNKNOWN_STATUS;
    },
    set(id, state, detail) {
      seq += 1;
      const status: ContainerStatus = Object.freeze({ state, seq, at: now(), ...detail });
      statuses.set(id, status);
      notify();
      return status;
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
