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
import { DEFAULT_PROJECT, renderCompose, type ComposeApplication } from './compose.js';
import { GENERATION_LABEL, runControllers } from './controllers.js';
import { createMemoryGenerationStore, type GenerationStore } from './generations.js';
import { applyRuntimeEvent, createObservedStore } from './observed.js';
import { formatPlan, planApply, planIsEmpty, type Plan } from './planner.js';
import { createRoot, EMPTY_DESIRED, type Root } from './reconciler.js';
import { digest, resourcesOfKind, type ContainerSpec, type DesiredState } from './resources.js';
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
  /**
   * `digest()` of the `ContainerSpec` these failures belong to.
   *
   * A restart history is a statement about *a thing that was run*, not about
   * a name. Keyed on the name alone, a container that crash-looped to
   * `maxRestarts` under a broken image stayed given up on after the image
   * was fixed: the fix is a different spec, it has never failed once, and
   * nothing would ever try it. Worse, it is silent — the give-up warning was
   * already logged, so the corrected version simply never starts.
   */
  specDigest: string;
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
 *
 * `resetAfterMs` is resolved the same way, and deliberately *not* via a
 * separate "is it healthy" check run on every pass: a container that stays
 * up quietly triggers no further passes at all (nothing about it is
 * changing), so there would be no reliable moment to run such a check. The
 * gate instead resolves it lazily, the next time it actually matters: at the
 * start of handling a *new* crash, `now - record.lastAt >= resetAfterMs`
 * means the previous trouble is old news, and this crash is treated exactly
 * like a first-ever failure — immediate, uncounted against the old streak —
 * rather than an escalation of it.
 */
class RestartGate {
  private readonly records = new Map<string, RestartRecord>();

  constructor(
    private readonly policy: ResolvedPolicy,
    private readonly now: () => number,
  ) {}

  /**
   * `true` to include `name` this pass; a retry time; or `null` to give up
   * permanently.
   *
   * `specDigest` identifies *what* is being asked for, and a record only
   * applies while it still matches: edit the image, the command, the env —
   * anything — and the history of the previous spec is dropped rather than
   * held against its replacement. That is the difference between "this
   * container keeps dying" and "this name keeps dying", and only the first
   * is a reason to hold anything back.
   */
  admit(
    name: string,
    specDigest: string,
    phase: ContainerPhase | 'absent',
  ): true | { retryAt: number } | null {
    if (phase !== 'exited' && phase !== 'absent') return true; // running/waiting/unknown: never gated
    const record = this.forSpec(name, specDigest);
    if (phase === 'absent' && record === undefined) return true; // never created yet: nothing to gate

    const now = this.now();

    if (record === undefined || now - record.lastAt >= this.policy.resetAfterMs) {
      // A first-ever crash, a crash of a spec this gate has not seen fail
      // before, or one far enough past the last restart to count as a fresh
      // problem rather than a continuation: let the first restart through
      // immediately.
      this.records.set(name, {
        specDigest,
        consecutive: 1,
        nextAt: now + backoffDelay(1, this.policy),
        lastAt: now,
      });
      return true;
    }
    if (record.consecutive >= this.policy.maxRestarts) return null;
    if (now < record.nextAt) return { retryAt: record.nextAt };
    record.consecutive += 1;
    record.lastAt = now;
    record.nextAt = now + backoffDelay(record.consecutive, this.policy);
    return true;
  }

  /**
   * The record for this name *if it is still about this spec*. A record for
   * a spec that is no longer wanted is deleted here rather than left to be
   * skipped over, so nothing downstream can read it by accident and so a
   * later crash of the new spec starts a genuinely fresh streak.
   */
  private forSpec(name: string, specDigest: string): RestartRecord | undefined {
    const record = this.records.get(name);
    if (record === undefined) return undefined;
    if (record.specDigest === specDigest) return record;
    this.records.delete(name);
    return undefined;
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
  /**
   * Where past Deployment template generations are remembered, so a rollout
   * interrupted by a restart can still reproduce the generation it was
   * draining. See `generations.ts`.
   *
   * The default remembers nothing across processes, because a library
   * function should not write to somebody's disk just for being called —
   * `fiber-servo plan` and the test suite both call `serve` and neither
   * should leave anything behind. A long-lived `fiber-servo up` passes a
   * file-backed store (`createGenerationStore`), which is the only case
   * where surviving a restart means anything.
   */
  generations?: GenerationStore;
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
  const generations = options.generations ?? createMemoryGenerationStore();
  const runtime: Runtime = options.runtime({ log, onError, project });
  const warnedGiveUp = new Set<string>();

  let desired: DesiredState = EMPTY_DESIRED;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Loop-guard state; see `wedged` below.
  let lastModel = '';
  /**
   * The model most recently handed to `runtime.apply`.
   *
   * Only the networks in it are read back (see `Plan.networks`): they are the
   * one part of the model with nothing observable behind it, because Compose
   * owns their lifecycle and `ObservedState` therefore carries none. Keeping
   * it here rather than deriving it is a deliberate, bounded exception to
   * "every pass recomputes from observed state" — and a safe one, since a
   * process that has just started has no previous model, treats every
   * declared network as new, and applies once. The cost of that is a single
   * idempotent `compose up`.
   */
  let lastApplied: ComposeApplication | undefined;
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

    // 1. Controllers: management resources become the containers that should
    //    exist. Every Deployment's current template is recorded first, so
    //    that when it stops being the current one there is still somewhere
    //    to read it from — the controllers themselves stay pure, taking the
    //    accumulated map as an ordinary argument.
    for (const deployment of resourcesOfKind(desired, 'deployment')) {
      generations.remember(deployment.spec.template);
    }
    const target = runControllers(desired, snapshot, generations.all());

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
      // The same digest the runtime records in `SPEC_LABEL`, so "has this
      // changed" means one thing across the whole write path.
      const specDigest = digest(spec);
      const verdict = gate.admit(spec.name, specDigest, phase);
      if (verdict === null) {
        if (!warnedGiveUp.has(spec.name)) {
          warnedGiveUp.add(spec.name);
          log(`giving up on ${spec.name} after ${policy.maxRestarts} restarts; edit its spec to try again`);
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

    // 3. Build the Compose Application Model this pass would apply, and stop
    //    if reconciling it is not converging (see `wedged` below).
    const plan = planApply(
      { networks: target.networks, containers: included },
      snapshot,
      project,
      lastApplied,
    );
    if (wedged(plan)) return;

    options.onApply?.(plan);
    // A pass with nothing pending is not merely quiet to log about — calling
    // `apply` at all would be pointless work for a real actuator (a whole
    // `nerdctl compose up` invocation) to prove what this plan already
    // proves for free: recomputing it is exactly how the runtime itself
    // would answer "does anything need to change", and this pass just did
    // that computation already. Skipping it here is also what keeps a
    // notify-triggered reflow pass (`apply()` notifying observed state
    // synchronously, which re-triggers `request()` before this pass has
    // even returned) from being a second, redundant call into the runtime
    // for the same already-settled state.
    if (planIsEmpty(plan)) return;

    // One log line per pending change, the same way the old action-list
    // write path logged one line per action.
    for (const line of formatPlan(plan).split('\n')) log(line);

    // 4. Hand the whole model to the runtime. It decides create vs. replace
    //    vs. leave-alone; this loop no longer does.
    await runtime.apply(plan.model);
    lastApplied = plan.model;

    // Forget generations nothing refers to any more: every one currently
    // declared, plus every one a container is still running under. Without
    // this the store grows by one entry per template edit, for ever.
    generations.prune([
      ...resourcesOfKind(desired, 'deployment').map((d) => digest(d.spec.template)),
      ...[...snapshot.containers.values()]
        .map((c) => c.labels[GENERATION_LABEL])
        .filter((g): g is string => g !== undefined),
    ]);
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
    const total = plan.missing.length + plan.changed.length + plan.orphaned.length + plan.restarting.length;
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
      // Let the unmount-triggered pass (if any) actually finish before
      // tearing anything down — otherwise it can still be mid-flight,
      // calling into a runtime that `close()` has already released.
      await request();
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      unsubscribeObserved();
      // Stay subscribed through `down()` itself: it notifies removals just
      // like any other runtime call, and `observed` should end up accurate
      // (empty) rather than stale, even though nothing is left to react to
      // those notifications since `stopped` is already true.
      await runtime.down();
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
