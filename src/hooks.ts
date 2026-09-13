/**
 * The bridge from the status store into the tree.
 *
 * `useContainerStatus` is a plain `useSyncExternalStore` read. `useSelfHeal`
 * turns observed deaths into a desired restart generation, which is the only
 * thing the tree can say about status: "I want attempt n of this container".
 */
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { type ContainerStatus, type StatusStore, createStatusStore } from './status.js';

export const StatusContext = createContext<StatusStore>(createStatusStore());

export function useStatusStore(): StatusStore {
  return useContext(StatusContext);
}

export function useContainerStatus(id: string): ContainerStatus {
  const store = useStatusStore();
  return useSyncExternalStore(store.subscribe, () => store.get(id));
}

export interface RestartPolicy {
  /** Delay before the first restart. Default 1000. */
  baseDelayMs?: number;
  /** Multiplier applied per consecutive restart. Default 2. */
  factor?: number;
  /** Upper bound for the delay. Default 300000 (5 min). */
  maxDelayMs?: number;
  /** Give up after this many consecutive restarts. Default: unlimited. */
  maxRestarts?: number;
  /** Running this long resets the consecutive counter (and the backoff). Default 600000 (10 min). */
  resetAfterMs?: number;
}

export type RestartMode = 'always' | 'never' | RestartPolicy;

interface ResolvedPolicy {
  baseDelayMs: number;
  factor: number;
  maxDelayMs: number;
  maxRestarts: number;
  resetAfterMs: number;
}

export const DEFAULT_RESTART_POLICY: Readonly<ResolvedPolicy> = Object.freeze({
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 300_000,
  maxRestarts: Number.POSITIVE_INFINITY,
  resetAfterMs: 600_000,
});

export function backoffDelay(consecutiveRestarts: number, policy: ResolvedPolicy): number {
  return Math.min(policy.baseDelayMs * policy.factor ** consecutiveRestarts, policy.maxDelayMs);
}

interface HealState {
  /** Desired restart generation; becomes the `restarts` host prop. */
  generation: number;
  /** Restarts issued since the container last ran long enough to reset. */
  consecutive: number;
  /** `seq` of the death event the latest restart answered. */
  handledSeq: number;
}

const INITIAL: HealState = { generation: 0, consecutive: 0, handledSeq: 0 };

/**
 * Returns the restart generation for `id`. It advances once per death event,
 * after the policy's backoff, and never twice for the same event: a death
 * that is already being answered waits for the runtime to report back.
 */
export function useSelfHeal(id: string, mode: RestartMode = 'always'): number {
  const status = useContainerStatus(id);
  const [state, setState] = useState<HealState>(INITIAL);

  const raw = mode === 'always' ? {} : mode === 'never' ? null : mode;
  const policy = useMemo<ResolvedPolicy | null>(
    () => (raw === null ? null : { ...DEFAULT_RESTART_POLICY, ...stripUndefined(raw) }),
    // Rebuild only when a field changes, not when the caller passes a new literal.
    [raw?.baseDelayMs, raw?.factor, raw?.maxDelayMs, raw?.maxRestarts, raw?.resetAfterMs, raw === null],
  );

  // Death -> (backoff) -> next generation.
  useEffect(() => {
    if (policy === null || status.state !== 'dead' || status.seq === state.handledSeq) return;
    if (state.consecutive >= policy.maxRestarts) return;
    const delay = backoffDelay(state.consecutive, policy);
    const timer = setTimeout(() => {
      setState((s) => ({ generation: s.generation + 1, consecutive: s.consecutive + 1, handledSeq: status.seq }));
    }, delay);
    return () => clearTimeout(timer);
  }, [policy, status, state.consecutive, state.handledSeq]);

  // Running for long enough -> forget the crash history.
  useEffect(() => {
    if (policy === null || status.state !== 'running' || state.consecutive === 0) return;
    const timer = setTimeout(() => setState((s) => ({ ...s, consecutive: 0 })), policy.resetAfterMs);
    return () => clearTimeout(timer);
  }, [policy, status, state.consecutive]);

  return state.generation;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
