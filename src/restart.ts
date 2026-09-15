/**
 * Restart backoff policy and the React-facing admission state.
 *
 * The runtime still owns the timer that actually wakes the process, but the
 * decision to render a crashed Container belongs to its React component.
 */
import { digest } from './resources.js';
import type { ContainerSpec } from './resources.js';

export interface RestartPolicy {
  /** Delay before the first replacement. Default 1000. */
  baseDelayMs?: number;
  /** Multiplier applied per consecutive replacement. Default 2. */
  factor?: number;
  /** Upper bound for the delay. Default 300000 (5 min). */
  maxDelayMs?: number;
  /** Give up after this many consecutive replacements. Default: unlimited. */
  maxRestarts?: number;
  /** Staying up this long resets the consecutive counter. Default 600000 (10 min). */
  resetAfterMs?: number;
}

export type ResolvedRestartPolicy = Required<RestartPolicy>;

export const DEFAULT_RESTART_POLICY: Readonly<ResolvedRestartPolicy> = Object.freeze({
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 300_000,
  maxRestarts: Number.POSITIVE_INFINITY,
  resetAfterMs: 600_000,
});

export function resolveRestartPolicy(policy: RestartPolicy = {}): ResolvedRestartPolicy {
  return { ...DEFAULT_RESTART_POLICY, ...stripUndefined(policy) };
}

export function backoffDelay(consecutive: number, policy: ResolvedRestartPolicy): number {
  return Math.min(policy.baseDelayMs * policy.factor ** consecutive, policy.maxDelayMs);
}

export interface RestartContextValue {
  policy: ResolvedRestartPolicy;
  now: () => number;
  onGiveUp?: (name: string, maxRestarts: number) => void;
}

export interface RestartRecord {
  specDigest: string;
  consecutive: number;
  nextAt: number;
  lastAt: number;
  warned: boolean;
}

/** Decide whether a Container should be present in this render. */
export function admitRestart(
  record: RestartRecord | undefined,
  spec: ContainerSpec,
  phase: 'waiting' | 'running' | 'exited' | 'unknown' | 'absent',
  context: RestartContextValue,
): { admitted: boolean; record?: RestartRecord; retryAt?: number; gaveUp?: boolean } {
  const specDigest = digest(spec);
  if (record?.specDigest !== specDigest) record = undefined;
  if (phase !== 'exited' && phase !== 'absent') return { admitted: true, record };
  if (phase === 'absent' && record === undefined) return { admitted: true };

  const now = context.now();
  if (record === undefined || now - record.lastAt >= context.policy.resetAfterMs) {
    const next: RestartRecord = {
      specDigest,
      consecutive: 1,
      nextAt: now + backoffDelay(1, context.policy),
      lastAt: now,
      warned: false,
    };
    return { admitted: true, record: next };
  }
  if (record.consecutive >= context.policy.maxRestarts) {
    return { admitted: false, record: { ...record, warned: true }, gaveUp: !record.warned };
  }
  if (now < record.nextAt) return { admitted: false, record, retryAt: record.nextAt };

  const next: RestartRecord = {
    ...record,
    consecutive: record.consecutive + 1,
    lastAt: now,
    nextAt: now + backoffDelay(record.consecutive + 1, context.policy),
  };
  return { admitted: true, record: next };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
