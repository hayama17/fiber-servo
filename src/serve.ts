/**
 * The control loop: where the two reconciliations meet, and the only file that
 * needs to understand both.
 *
 * ```text
 *   React commit ─────┐
 *                     ├──> reconcile() ──> controllers ──> Compose model ──> Runtime.apply
 *   runtime event ────┘         ▲                                              │
 *                               └──────────────── observed state ◄─────────────┘
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
 *
 * What changed with the move to Compose: there is no more action list to
 * execute one at a time. `pass()` builds the whole desired Compose
 * Application Model and hands it to `runtime.apply()` in a single call — the
 * runtime decides create vs. replace vs. leave-alone, not this file. What
 * this file still owns, because it needs memory across ticks that a pure
 * `(desired, observed) => x` function cannot have, is the restart backoff
 * gate: *whether* a container that is currently `exited` gets included in
 * this pass's model at all.
 */
import type { ReactNode } from 'react';
import { DEFAULT_PROJECT, renderCompose, toComposeApplication } from './compose.js';
import { runControllers } from './controllers.js';
import { applyRuntimeEvent, createObservedStore } from './observed.js';
import { planApply, type Plan } from './planner.js';
import { createRoot, EMPTY_DESIRED, type Root } from './reconciler.js';
import type { ContainerSpec, DesiredState } from './resources.js';
import type { ContainerPhase, ObservedStore, Runtime, RuntimeFactory } from './runtime/types.js';

// ---- restart backoff --------------------------------------------------------

/**
 * How eagerly a crash-looping container is replaced.
 *
 * This is the one piece of state the control loop keeps between ticks, and it
 * is why crash backoff lives here rather than in the controllers: those are
 * pure functions of (desired, observed), and "how many times has this
 * already failed" is neither.
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
  /** Being let through and staying up this long resets the consecutive counter. Default 600000 (10 min). */
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

/**
 * How many times the control loop will reconcile an identical Compose model
 * before concluding it is not converging. Generous enough that no honest
 * rollout reaches it, small enough that a bug costs a few operations rather
 * than a pegged CPU.
 */
const MAX_IDENTICAL_PASSES = 20;

interface RestartRecord {
  consecutive: number;
  /** Earliest time this container may be admitted again after an exit. */
  nextAt: number;
  /**
   * When the gate last admitted this container. This — not any timestamp
   * `ObservedContainer` carries — is what `resetAfterMs` measures against.
   * `ObservedContainer.at` is an *observation* timestamp: it advances on
   * every heartbeat a container is still merely sitting there running, so
   * "now - lastObservedAt" almost never grows past a few milliseconds and a
   * reset condition built on it effectively never fires. The gate's own
   * `lastAt` only moves when *this gate* let a restart through, so
   * `now - lastAt` genuinely measures "how long has it been since we last
   * had to do anything about this container".
   */
  lastAt: number;
}

/**
 * Decides whether a container that is currently `exited` may be included in
 * *this* pass's Compose model — which is the only lever this control loop
 * has left to say "not yet". Under the old op-based write path a backed-off
 * container simply sat there, still reported `exited`, while nothing acted
 * on it. Compose does not offer that: `Runtime.apply` treats "declared but
 * absent from the model" as "remove it", so the moment this gate holds a
 * container back, the next observation reports it *absent*, not `exited` —
 * the very phase that justified the hold is now gone from view.
 *
 * That is why `admit` treats `absent` exactly like `exited` whenever it
 * already has a record for the name: the gate's own bookkeeping is the only
 * thing that remembers a hold is in progress once the runtime has honoured
 * it by removing the container. A brand-new `absent` name with no record at
 * all — a container that has simply never been created yet — passes
 * straight through; nothing here ever gates a container's *first* creation.
 */
class RestartGate {
  private readonly records = new Map<string, RestartRecord>();

  constructor(
    private readonly policy: ResolvedPolicy,
    private readonly now: () => number,
  ) {}

  /** `true` to include `name` this pass; a retry time; or `null` to give up permanently. */
  admit(name: string, phase: ContainerPhase | 'absent'): true | { retryAt: number } | null {
    const now = this.now();
    const record = this.records.get(name);

    if (phase === 'running') {
      // A long enough run, undisturbed by this gate, earns a clean slate.
      if (record !== undefined && now - record.lastAt >= this.policy.resetAfterMs) {
        this.records.delete(name);
      }
      return true;
    }
    if (phase !== 'exited' && phase !== 'absent') return true; // waiting/unknown: never gated
    if (phase === 'absent' && record === undefined) return true; // never created yet: nothing to gate

    if (record === undefined) {
      // A first-ever crash is always let through immediately; only a
      // *second* failure within the resulting window is ever held back.
      this.records.set(name, { consecutive: 1, nextAt: now + backoffDelay(1, this.policy), lastAt: now });
      return true;
    }
    if (record.consecutive >= this.policy.maxRestarts) return null;
    if (now < record.nextAt) return { retryAt: record.nextAt };
    record.consecutive += 1;
    record.lastAt = now;
    record.nextAt = now + backoffDelay(record.consecutive, this.policy);
    return true;
  }

  /** Drop bookkeeping for a container the tree no longer wants at all. */
  forget(name: string): void {
    this.records.delete(name);
  }

  /** Names this gate currently holds a record for, so a caller can prune ones no longer desired. */
  names(): IterableIterator<string> {
    return this.records.keys();
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
  /** Observe the plan each pass is about to apply (after the restart gate has filtered it). */
  onApply?: (plan: Plan) => void;
  restart?: RestartPolicy;
  /** The Compose project this tree applies as. Default: `compose.ts`'s `DEFAULT_PROJECT`. */
  project?: string;
  now?: () => number;
}

export interface Served {
  root: Root;
  observed: ObservedStore;
  /** Run one reconcile now and wait for it. */
  reconcile(): Promise<void>;
  /** Wait for any reconcile already in flight or queued. */
  idle(): Promise<void>;
  /** Unmount the tree and remove the whole application from the runtime. */
  stop(): Promise<void>;
}

export function serve(element: ReactNode, options: ServeOptions): Served {
  const log = options.log ?? (() => {});
  const onError = options.onError ?? ((e: Error) => console.error(e));
  const now = options.now ?? Date.now;
  const observed = options.observed ?? createObservedStore(now);
  const policy: ResolvedPolicy = { ...DEFAULT_RESTART_POLICY, ...stripUndefined(options.restart ?? {}) };
  const project = options.project ?? DEFAULT_PROJECT;
  const gate = new RestartGate(policy, now);
  const runtime: Runtime = options.runtime({ log, onError });
  const warnedGiveUp = new Set<string>();

  let desired: DesiredState = EMPTY_DESIRED;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Loop-guard state; see `wedged` below.
  let lastModel = '';
  let repeats = 0;
  let stalled = false;

  /**
   * Serialise reconciles and coalesce requests. A burst of runtime events
   * during one pass produces exactly one more pass, not one per event: since
   * every pass reads current state, a pass that has not started yet is
   * indistinguishable from one that has not been requested yet.
   */
  function request(): Promise<void> {
    if (stopped || stalled) return Promise.resolve();
    if (running !== null) {
      again = true;
      return running;
    }
    // Start the pass on a microtask rather than calling it here.
    //
    // `pass()` runs synchronously until its first await, and the first thing
    // it awaits is a runtime call — which, for an in-process adapter, notifies
    // its subscribers synchronously. That notification calls `request()` again
    // while `running` is still null, because the assignment below has not
    // happened yet, and a second pass starts on top of the first. Two passes
    // reading the same stale snapshot then both decide to create the same
    // container. Deferring by one microtask means `running` is set before any
    // of that can happen, so the guard above actually guards.
    running = Promise.resolve()
      .then(pass)
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

    // 1. Controllers: management resources become the containers that should exist.
    const target = runControllers(desired, snapshot);

    // 2. The restart gate: which of those containers are actually admitted
    //    into this pass's model. This is the one thing `runControllers`
    //    cannot decide on its own — it has no memory of past failures.
    const desiredNames = new Set(target.containers.map((c) => c.name));
    for (const name of [...gate.names()]) {
      if (!desiredNames.has(name)) gate.forget(name); // no longer wanted at all: history is moot
    }

    let soonest = Number.POSITIVE_INFINITY;
    const included: ContainerSpec[] = [];
    for (const spec of target.containers) {
      const phase = snapshot.containers.get(spec.name)?.phase ?? 'absent';
      const verdict = gate.admit(spec.name, phase);
      if (verdict === null) {
        if (!warnedGiveUp.has(spec.name)) {
          warnedGiveUp.add(spec.name);
          log(`giving up on ${spec.name} after ${policy.maxRestarts} restarts`);
        }
        continue;
      }
      if (verdict !== true) {
        soonest = Math.min(soonest, verdict.retryAt);
        continue;
      }
      warnedGiveUp.delete(spec.name);
      included.push(spec);
    }
    if (soonest !== Number.POSITIVE_INFINITY) scheduleRetry(soonest);
    // Note that the loop above already cleared any gate record for a
    // container this pass observes `running` for long enough (see
    // `RestartGate.admit`'s `running` branch) — there is no separate
    // "mark healthy" step to run afterwards.

    // 3. Build the Compose Application Model this pass would apply, and stop
    //    if reconciling it is not converging (see `wedged` below).
    const plan = planApply({ networks: target.networks, containers: included }, snapshot, project);
    if (wedged(plan)) return;

    options.onApply?.(plan);
    log(formatShort(plan));

    // 4. Hand the whole model to the runtime. It decides create vs. replace
    //    vs. leave-alone; this loop no longer does.
    await runtime.apply(plan.model);
  }

  function formatShort(plan: Plan): string {
    const total = plan.missing.length + plan.changed.length + plan.orphaned.length;
    return total === 0
      ? 'apply: nothing to do'
      : `apply: ${plan.missing.length} create, ${plan.changed.length} replace, ${plan.orphaned.length} remove`;
  }

  /**
   * Stop a loop that is not getting anywhere.
   *
   * Applying a model changes observed state, which schedules another pass —
   * which is exactly right while each pass makes progress. But if applying a
   * model fails to change what the next pass observes (an adapter that
   * mutates something without reporting the new state, say), the same model
   * comes back for ever and the loop hammers the runtime as fast as it can.
   *
   * A rollout legitimately runs many passes in a row, so "many passes" is not
   * the signal. *Identical* models are: a pass that would apply exactly what
   * the last one applied, repeatedly, is by definition not converging.
   * Report it once and stand down until the desired state changes, rather
   * than burning the machine on a bug.
   */
  function wedged(plan: Plan): boolean {
    const total = plan.missing.length + plan.changed.length + plan.orphaned.length;
    if (total === 0) {
      repeats = 0;
      lastModel = '';
      return false;
    }
    const text = renderCompose(plan.model);
    repeats = text === lastModel ? repeats + 1 : 0;
    lastModel = text;
    if (repeats < MAX_IDENTICAL_PASSES) return false;
    stalled = true;
    onError(
      new Error(
        `fiber-servo: the same Compose model has been reconciled ${repeats} times without converging, so ` +
          `it has been stopped. This means applying it is not changing what the next pass observes. ` +
          `Pending: ${plan.missing.length} create, ${plan.changed.length} replace, ${plan.orphaned.length} remove.`,
      ),
    );
    return true;
  }

  const unsubscribeRuntime = runtime.subscribe((event) => {
    applyRuntimeEvent(observed, event);
  });
  // Observed state changing is a reason to reconcile — and the only way a
  // dead container ever gets replaced. Note that nothing here re-renders React.
  const unsubscribeObserved = observed.subscribe(() => void request());

  const root = createRoot({
    observed,
    onCommit: (next) => {
      desired = next;
      // A new desired state is new information, so a stalled loop gets another
      // chance: whatever the operator just changed may well be the fix.
      stalled = false;
      repeats = 0;
      lastModel = '';
      options.onDesired?.(next);
      void request();
    },
  });

  // Adopt whatever is already running before the first commit, so a restarted
  // process reconciles against reality instead of assuming an empty machine.
  const started = runtime
    .inspect()
    .then((state) => observed.reset(state.containers.values()))
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
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      unsubscribeObserved();
      unsubscribeRuntime();
      await runtime.down();
      await runtime.close?.();
    },
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
