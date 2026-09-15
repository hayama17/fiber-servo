/**
 * The control loop: where the two reconciliations meet, and the only file that
 * needs to understand both.
 *
 * ```text
 *   React commit ─────┐
 *                     ├──> reconcile() ──> Compose model ──> Runtime.apply
 *   runtime event ────┘         ▲                                              │
 *                               └──────────────── observed state ◄─────────────┘
 * ```
 *
 * Both arrows into `reconcile()` mean the same thing — "something might now be
 * out of date" — and neither says what to do about it. That is the whole point
 * of the split: a React commit changes what we want, a runtime event changes
 * what is, and in both cases the answer is to let React recompute the runtime
 * resource tree from scratch. There is no incremental diff to keep in sync,
 * and therefore nothing to get out of sync.
 *
 * The loop is level-triggered, not edge-triggered: it reads the current
 * desired state and the current observed state every tick and acts on the
 * difference. A missed event costs a late reconcile, never a wrong one.
 *
 * What changed with the move to Compose: there is no more action list to
 * execute one at a time. `pass()` builds the whole desired Compose
 * Application Model and hands it to `runtime.apply()` in a single call — the
 * runtime decides create vs. replace vs. leave-alone, not this file. Restart
 * admission is decided by each React Container controller; this loop only
 * schedules the I/O that applies the committed model.
 */
import type { ReactNode } from 'react';
import { DEFAULT_PROJECT, renderCompose, type ComposeApplication } from './compose.js';
import { applyRuntimeEvent, createObservedStore } from './observed.js';
import type { GenerationHistory } from './generations.js';
import { formatPlan, planApply, planIsEmpty, type Plan } from './planner.js';
import { createRoot, EMPTY_DESIRED, type Root } from './reconciler.js';
import { resourcesOfKind, type DesiredState } from './resources.js';
import { resolveRestartPolicy, type RestartPolicy } from './restart.js';
import type { ObservedStore, Runtime, RuntimeFactory } from './runtime/types.js';

/**
 * How many times the control loop will reconcile an identical Compose model
 * before concluding it is not converging. Generous enough that no honest
 * rollout reaches it, small enough that a bug costs a few operations rather
 * than a pegged CPU.
 */
const MAX_IDENTICAL_PASSES = 20;

// ---- serve ------------------------------------------------------------------

export interface ServeOptions {
  runtime: RuntimeFactory;
  observed?: ObservedStore;
  log?: (line: string) => void;
  onError?: (error: Error) => void;
  /** Observe each desired-state snapshot React commits. */
  onDesired?: (desired: DesiredState) => void;
  /** Observe the plan each pass is about to apply. */
  onApply?: (plan: Plan) => void;
  restart?: RestartPolicy;
  /** The Compose project this tree applies as. Default: `compose.ts`'s `DEFAULT_PROJECT`. */
  project?: string;
  /**
   * @deprecated Deployment components own their history. This option remains
   * accepted for source compatibility and is no longer read by `serve`.
   */
  generations?: GenerationHistory;
  now?: () => number;
}

export interface Served {
  root: Root;
  observed: ObservedStore;
  /** Run one reconcile now and wait for it. */
  reconcile(): Promise<void>;
  /** Wait for any reconcile already in flight or queued. */
  idle(): Promise<void>;
  /**
   * Unmount the tree and remove the whole application from the runtime.
   *
   * This ends the *application*: `runtime.down()` is called, so the
   * containers and the network go too. For ending only the control plane,
   * see `detach`.
   */
  stop(): Promise<void>;

  /**
   * End the control plane and leave the runtime exactly as it is.
   *
   * ```text
   * detach()   control plane stops.       containers and networks stay.
   * stop()     the application stops.     runtime.down() removes them.
   * ```
   *
   * This is what "the fiber-servo process died" looks like from inside one
   * process: reconcile requests stop being accepted, controller subscriptions
   * are dropped, the tree is unmounted, and every piece of controller state —
   * the restart records, the rollout history, the
   * last applied model — goes with it. Nothing is asked of the runtime, and
   * the adapter is left open, because a process that has crashed does not
   * politely close its socket either.
   *
   * It exists because that state is not observable from outside, and a test
   * that merely stops calling a `serve()` has not detached it: it still holds
   * a runtime subscription, still reconciles when an event arrives, and can
   * still apply its own stale idea of desired state on top of whoever
   * replaced it. Real code wants it too — anything that hands a machine over
   * to another process, or swaps a control plane without an outage.
   */
  detach(): Promise<void>;
}

export function serve(element: ReactNode, options: ServeOptions): Served {
  const log = options.log ?? (() => {});
  const onError = options.onError ?? ((e: Error) => console.error(e));
  const now = options.now ?? Date.now;
  const observed = options.observed ?? createObservedStore(now);
  const policy = resolveRestartPolicy(options.restart);
  const project = options.project ?? DEFAULT_PROJECT;
  const runtime: Runtime = options.runtime({ log, onError, project });

  let desired: DesiredState = EMPTY_DESIRED;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
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

  async function pass(): Promise<void> {
    const snapshot = observed.snapshot();

    // React controller components have already expanded management resources
    // into runtime Containers. The root only collects their committed output.
    const target = {
      networks: resourcesOfKind(desired, 'network').map((resource) => resource.spec),
      containers: resourcesOfKind(desired, 'container').map((resource) => resource.spec),
    };

    // 2. Build the Compose Application Model this pass would apply, and stop
    //    if reconciling it is not converging (see `wedged` below).
    const plan = planApply(
      { networks: target.networks, containers: target.containers },
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

    // 3. Hand the whole model to the runtime. It decides create vs. replace
    //    vs. leave-alone; this loop no longer does.
    await runtime.apply(plan.model);
    lastApplied = plan.model;
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

  let reactRoot: Root | undefined;
  const unsubscribeRuntime = runtime.subscribe((event) => {
    applyRuntimeEvent(observed, event);
    // Runtime events update useSyncExternalStore subscribers synchronously
    // before the control loop computes its next model. This keeps the model
    // that `pass()` reads aligned with the React commit caused by the event.
    try {
      reactRoot?.flush();
    } catch (error: unknown) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
  // Observed state changing is a reason to reconcile — and also wakes the
  // React controllers through their external-store subscriptions.
  const unsubscribeObserved = observed.subscribe(() => void request());

  const root = createRoot({
    observed,
    restart: {
      policy,
      now,
      onGiveUp: (name, maxRestarts) =>
        log(`giving up on ${name} after ${maxRestarts} restarts; edit its spec to try again`),
    },
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
  reactRoot = root;

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
    async detach() {
      await started;
      // Take the loop out of service *first*: unmounting commits an empty
      // desired state, and a control plane on its way out must not apply
      // that. `stopped` makes `request()` a no-op, so the commit updates
      // this process's own `desired` and reaches no runtime.
      stopped = true;
      unsubscribeObserved();
      unsubscribeRuntime();
      // Drain anything already in flight, so nothing lands after the caller
      // believes this control plane is gone.
      while (running !== null) await running;
      root.unmount();
      // Deliberately not `runtime.down()`, and deliberately not
      // `runtime.close()`: the whole point is that the machine is untouched.
    },
    async stop() {
      await started;
      root.unmount();
      // Let the unmount-triggered pass (if any) actually finish before
      // tearing anything down — otherwise it can still be mid-flight,
      // calling into a runtime that `close()` has already released.
      await request();
      stopped = true;
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

export { DEFAULT_RESTART_POLICY, backoffDelay } from './restart.js';
export type { RestartPolicy } from './restart.js';
