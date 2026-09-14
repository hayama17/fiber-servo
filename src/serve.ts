/**
 * The control loop: where the two reconciliations meet, and the only file that
 * needs to understand both.
 *
 * ```text
 *   React commit ─────┐
 *                     ├──> reconcile() ──> controllers ──> planner ──> Runtime
 *   runtime event ────┘         ▲                                        │
 *                               └──────────── observed state ◄───────────┘
 * ```
 *
 * Both arrows into `reconcile()` mean the same thing — "something might now be
 * out of date" — and neither says what to do about it. That is the whole point
 * of the split: a React commit changes what we want, a runtime event changes
 * what is, and in both cases the answer is to recompute the difference from
 * scratch. There is no incremental diff to keep in sync, and therefore nothing
 * to get out of sync.
 *
 * The loop is level-triggered, not edge-triggered: it reads the current
 * desired state and the current observed state every tick and acts on the
 * difference. A missed event costs a late reconcile, never a wrong one.
 */
import type { ReactNode } from 'react';
import { runControllers } from './controllers.js';
import { applyRuntimeEvent, createObservedStore } from './observed.js';
import { formatAction, planAll, type Action } from './planner.js';
import { createRoot, EMPTY_DESIRED, type Root } from './reconciler.js';
import type { DesiredState } from './resources.js';
import type { ObservedStore, Runtime, RuntimeFactory } from './runtime/types.js';

// ---- restart backoff --------------------------------------------------------

/**
 * How eagerly a crash-looping Pod is replaced.
 *
 * This is the one piece of state the control loop keeps between ticks, and it
 * is why crash backoff lives here rather than in the controllers or the
 * planner: both of those are pure functions of (desired, observed), and
 * "how many times has this already failed" is neither.
 */
export interface RestartPolicy {
  /** Delay before the first replacement. Default 1000. */
  baseDelayMs?: number;
  /** Multiplier applied per consecutive replacement. Default 2. */
  factor?: number;
  /** Upper bound for the delay. Default 300000 (5 min). */
  maxDelayMs?: number;
  /** Give up after this many consecutive replacements. Default: unlimited. */
  maxRestarts?: number;
  /** Running this long resets the consecutive counter. Default 600000 (10 min). */
  resetAfterMs?: number;
}

type ResolvedPolicy = Required<RestartPolicy>;

export const DEFAULT_RESTART_POLICY: Readonly<ResolvedPolicy> = Object.freeze({
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 300_000,
  maxRestarts: Number.POSITIVE_INFINITY,
  resetAfterMs: 600_000,
});

export function backoffDelay(consecutive: number, policy: ResolvedPolicy): number {
  return Math.min(policy.baseDelayMs * policy.factor ** consecutive, policy.maxDelayMs);
}

interface RestartRecord {
  consecutive: number;
  /** Earliest time the next replacement of this Pod may happen. */
  nextAt: number;
  /** When the last replacement was allowed, so a healthy run can clear the count. */
  lastAt: number;
}

/**
 * Decides whether a Pod that died may be replaced *now*.
 *
 * A Pod whose image is simply wrong will die immediately, every time. Without
 * this gate the loop would recreate it as fast as the runtime can fail, which
 * is a busy loop with container churn attached.
 */
class RestartGate {
  private readonly records = new Map<string, RestartRecord>();

  constructor(
    private readonly policy: ResolvedPolicy,
    private readonly now: () => number,
  ) {}

  /** `true` to go ahead; otherwise the time to try again, or `null` to give up. */
  allow(pod: string): true | { retryAt: number } | null {
    const now = this.now();
    const record = this.records.get(pod);
    if (record === undefined) {
      this.records.set(pod, { consecutive: 1, nextAt: now + backoffDelay(1, this.policy), lastAt: now });
      return true;
    }
    if (record.consecutive >= this.policy.maxRestarts) return null;
    if (now < record.nextAt) return { retryAt: record.nextAt };
    record.consecutive += 1;
    record.lastAt = now;
    record.nextAt = now + backoffDelay(record.consecutive, this.policy);
    return true;
  }

  /** A Pod that has been up long enough has earned a clean slate. */
  observeHealthy(pod: string, runningSince: number): void {
    const record = this.records.get(pod);
    if (record === undefined) return;
    if (this.now() - runningSince >= this.policy.resetAfterMs) this.records.delete(pod);
  }

  forget(pod: string): void {
    this.records.delete(pod);
  }
}

// ---- serve ------------------------------------------------------------------

export interface ServeOptions {
  runtime: RuntimeFactory;
  observed?: ObservedStore;
  log?: (line: string) => void;
  onError?: (error: Error) => void;
  /** Observe each desired-state snapshot React commits. */
  onDesired?: (desired: DesiredState) => void;
  /** Observe the actions of each reconcile, after the backoff gate. */
  onActions?: (actions: readonly Action[]) => void;
  restart?: RestartPolicy;
  now?: () => number;
}

export interface Served {
  root: Root;
  observed: ObservedStore;
  /** Run one reconcile now and wait for it. */
  reconcile(): Promise<void>;
  /** Wait for any reconcile already in flight or queued. */
  idle(): Promise<void>;
  /** Unmount the tree (desired state becomes empty), reconcile it away, stop watching. */
  stop(): Promise<void>;
}

export function serve(element: ReactNode, options: ServeOptions): Served {
  const log = options.log ?? (() => {});
  const onError = options.onError ?? ((e: Error) => console.error(e));
  const now = options.now ?? Date.now;
  const observed = options.observed ?? createObservedStore(now);
  const policy: ResolvedPolicy = { ...DEFAULT_RESTART_POLICY, ...stripUndefined(options.restart ?? {}) };
  const gate = new RestartGate(policy, now);
  const runtime: Runtime = options.runtime({ log, onError });

  let desired: DesiredState = EMPTY_DESIRED;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Serialise reconciles and coalesce requests. A burst of runtime events
   * during one pass produces exactly one more pass, not one per event: since
   * every pass reads current state, a pass that has not started yet is
   * indistinguishable from one that has not been requested yet.
   */
  function request(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running !== null) {
      again = true;
      return running;
    }
    running = pass()
      .catch((error: unknown) => onError(error instanceof Error ? error : new Error(String(error))))
      .then(() => {
        running = null;
        if (again && !stopped) {
          again = false;
          return request();
        }
        again = false;
        return undefined;
      });
    return running;
  }

  function scheduleRetry(at: number): void {
    const delay = Math.max(0, at - now());
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void request();
    }, delay);
    // Never hold the process open just to retry a backoff.
    retryTimer.unref?.();
  }

  async function pass(): Promise<void> {
    const snapshot = observed.snapshot();

    // 1. Controllers: management resources become the Pods that should exist.
    const target = runControllers(desired, snapshot);

    // 2. Planner: what must happen for reality to match them.
    const planned = planAll(target, snapshot);

    // 3. The backoff gate, the one thing the planner cannot decide on its own.
    const actions: Action[] = [];
    let soonest = Number.POSITIVE_INFINITY;
    for (const action of planned) {
      if (action.type === 'replace-pod' && action.because.includes('phase')) {
        const verdict = gate.allow(action.name);
        if (verdict === null) {
          log(`giving up on ${action.name} after ${policy.maxRestarts} restarts`);
          continue;
        }
        if (verdict !== true) {
          soonest = Math.min(soonest, verdict.retryAt);
          continue;
        }
      }
      actions.push(action);
    }
    if (soonest !== Number.POSITIVE_INFINITY) scheduleRetry(soonest);

    // A Pod that has stayed up is no longer a restart suspect.
    for (const pod of snapshot.pods.values()) {
      if (pod.phase === 'running') gate.observeHealthy(pod.name, pod.at);
    }

    options.onActions?.(actions);
    for (const action of actions) {
      log(formatAction(action));
      await execute(action);
    }
  }

  async function execute(action: Action): Promise<void> {
    switch (action.type) {
      case 'create-network':
        return runtime.createNetwork(action.spec);
      case 'replace-network':
        await runtime.removeNetwork(action.name);
        return runtime.createNetwork(action.spec);
      case 'remove-network':
        return runtime.removeNetwork(action.name);
      case 'create-pod':
        return runtime.createPod(action.spec);
      case 'replace-pod':
        // The stop/create sequence the rest of the system never has to know
        // about. This is the only place it exists.
        await runtime.removePod(action.name);
        gate.forget(action.name);
        return runtime.createPod(action.spec);
      case 'remove-pod':
        gate.forget(action.name);
        return runtime.removePod(action.name);
      case 'create-container':
        return runtime.createContainer(action.pod, action.spec);
      case 'replace-container':
        await runtime.removeContainer(action.pod, action.spec.name);
        return runtime.createContainer(action.pod, action.spec);
      case 'remove-container':
        return runtime.removeContainer(action.pod, action.name);
      case 'update-container-resources':
        return runtime.updateContainerResources(action.pod, action.name, action.resources);
    }
  }

  const unsubscribeRuntime = runtime.subscribe((event) => {
    applyRuntimeEvent(observed, event);
  });
  // Observed state changing is a reason to reconcile — and the only way a dead
  // Pod ever gets replaced. Note that nothing here re-renders React.
  const unsubscribeObserved = observed.subscribe(() => void request());

  const root = createRoot({
    observed,
    onCommit: (next) => {
      desired = next;
      options.onDesired?.(next);
      void request();
    },
  });

  // Adopt whatever is already running before the first commit, so a restarted
  // process reconciles against reality instead of assuming an empty machine.
  const started = runtime
    .inspect()
    .then((state) => observed.reset(state))
    .catch((error: unknown) => onError(error instanceof Error ? error : new Error(String(error))))
    .then(() => {
      root.render(element);
    });

  return {
    root,
    observed,
    async reconcile() {
      await started;
      await request();
    },
    async idle() {
      await started;
      while (running !== null) await running;
    },
    async stop() {
      await started;
      root.unmount();
      await request();
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      unsubscribeObserved();
      unsubscribeRuntime();
      await runtime.close?.();
    },
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
