/**
 * The React half of the control plane.
 *
 * `createRoot` renders a tree and publishes a `DesiredState` snapshot after
 * every commit. That is the entirety of React's job here. It never learns
 * whether a Pod actually started, and it is never asked to re-render because
 * one stopped — that is observed state, and it reaches the control loop by a
 * different path (see `observed.ts`).
 *
 * The tree can still *read* observed state, through `useReady` and friends, to
 * decide what it wants next: "don't declare the web Pod until the database is
 * ready" is a statement about desired state that happens to depend on an
 * observation. Reading is fine. What the tree must never do is restate an
 * observation as a fake desired-state change in order to provoke a commit.
 */
import { createElement, type ReactNode } from 'react';
import Reconciler from 'react-reconciler';
import { ConcurrentRoot } from 'react-reconciler/constants.js';
import { ObservedContext } from './hooks.js';
import { createObservedStore } from './observed.js';
import { createRootContainer, typedHostConfig, type RootContainer } from './hostConfig.js';
import type { DesiredState } from './resources.js';
import type { ObservedStore } from './runtime/types.js';

const reconciler = Reconciler(typedHostConfig);

/** An empty desired state: what a root holds before its first render. */
export const EMPTY_DESIRED: DesiredState = { resources: [] };

export interface Root {
  /**
   * Render `element` as the desired state and flush synchronously. When it
   * returns, the snapshot it produced has been handed to `onCommit`.
   */
  render(element: ReactNode): void;
  /**
   * Flush work scheduled outside `render()` — an observed-state event, a timer
   * — right now. Useful in tests with fake timers; otherwise this happens on
   * the next microtask by itself.
   */
  flush(): void;
  /**
   * Resolve once React has nothing left to commit. Unlike `flush()`, this also
   * waits for work that goes through the Scheduler (a Suspense retry after
   * `useReady` settles), which cannot be flushed synchronously.
   */
  settle(): Promise<void>;
  /** Tear the tree down. The next snapshot is empty, so everything is removed. */
  unmount(): void;
  /** The most recent snapshot. */
  desired(): DesiredState;
  /** The observed state this tree reads from. Runtimes and tests write to it. */
  readonly observed: ObservedStore;
}

export interface CreateRootOptions {
  /** Receives the snapshot after every commit. Defaults to no-op. */
  onCommit?: (desired: DesiredState) => void;
  /** Observed state to read from. A fresh, empty store is created when omitted. */
  observed?: ObservedStore;
  onUncaughtError?: (error: unknown) => void;
}

export function createRoot(options: CreateRootOptions = {}): Root {
  const observed = options.observed ?? createObservedStore();
  let latest: DesiredState = EMPTY_DESIRED;
  const container: RootContainer = createRootContainer((desired) => {
    latest = desired;
    options.onCommit?.(desired);
  });

  // React reports errors that escape every boundary through these callbacks,
  // from inside the commit. We park the first one and re-throw it once the
  // synchronous flush returns, so `render()` fails loudly and synchronously
  // instead of logging to console.error and moving on.
  let pendingError: { error: unknown } | null = null;
  const onError = (error: unknown): void => {
    if (options.onUncaughtError) options.onUncaughtError(error);
    else if (pendingError === null) pendingError = { error };
  };

  const fiberRoot = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    'fiber-servo',
    onError,
    onError,
    onError,
    () => {},
  );

  function flush(): void {
    reconciler.flushSyncWork();
    // Passive effects (useEffect) may schedule further sync updates; flush them too.
    reconciler.flushPassiveEffects();
    reconciler.flushSyncWork();
    if (pendingError !== null) {
      const { error } = pendingError;
      pendingError = null;
      throw error;
    }
  }

  function update(element: ReactNode): void {
    const tree = element === null ? null : createElement(ObservedContext, { value: observed }, element);
    reconciler.updateContainerSync(tree, fiberRoot, null, null);
    flush();
  }

  async function settle(): Promise<void> {
    // Give the Scheduler (setImmediate in Node) a macrotask, flush, and stop
    // once two consecutive rounds committed nothing.
    let quiet = 0;
    for (let i = 0; i < 100 && quiet < 2; i++) {
      const before = container.commits;
      await new Promise<void>((r) => setImmediate(r));
      flush();
      quiet = container.commits === before ? quiet + 1 : 0;
    }
  }

  return {
    observed,
    render(element) {
      update(element);
    },
    flush,
    settle,
    unmount() {
      update(null);
    },
    desired() {
      return latest;
    },
  };
}

/** Records every snapshot a root publishes. Handy for tests and dry runs. */
export function collectSnapshots(): {
  snapshots: DesiredState[];
  onCommit: (desired: DesiredState) => void;
  last(): DesiredState;
} {
  const snapshots: DesiredState[] = [];
  return {
    snapshots,
    onCommit(desired) {
      snapshots.push(desired);
    },
    last() {
      return snapshots[snapshots.length - 1] ?? EMPTY_DESIRED;
    },
  };
}
