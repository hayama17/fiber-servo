import { createElement, type ReactNode } from 'react';
import Reconciler from 'react-reconciler';
import { ConcurrentRoot } from 'react-reconciler/constants';
import { StatusContext } from './hooks.js';
import { createRootContainer, typedHostConfig, type RootContainer } from './hostConfig.js';
import type { InstanceKind, Op, OpSink } from './ops.js';
import { createStatusStore, type StatusStore } from './status.js';

const reconciler = Reconciler(typedHostConfig);

export interface Root {
  /**
   * Render `element` as the desired state and flush synchronously.
   * When it returns, every op the commit produced has been handed to the sink.
   */
  render(element: ReactNode): void;
  /**
   * Flush work scheduled outside `render()`: status-store events and timers
   * (self-healing) re-render on the next microtask by themselves; call this
   * to have them committed right now, e.g. in tests with fake timers.
   */
  flush(): void;
  /**
   * Resolve once React has nothing left to commit. Unlike `flush()`, this
   * also waits for work that goes through the Scheduler (a Suspense retry
   * after `useReady` settles), which cannot be flushed synchronously.
   */
  settle(): Promise<void>;
  /** Tear the tree down: emits DELETE for every live container. */
  unmount(): void;
  /** Ids of resources of `kind` (default containers) that currently have a CREATE outstanding, in creation order. */
  liveIds(kind?: InstanceKind): string[];
  /** The status store this tree reads from. Runtimes and tests write to it. */
  readonly status: StatusStore;
}

export interface CreateRootOptions {
  /** Receives one batch per commit. Defaults to no-op; use `collectOps` or a runtime. */
  sink?: OpSink;
  /** Status store to read from. A fresh one is created when omitted. */
  status?: StatusStore;
  onUncaughtError?: (error: unknown) => void;
}

export function createRoot(options: CreateRootOptions = {}): Root {
  const sink = options.sink ?? (() => {});
  const status = options.status ?? createStatusStore();
  const container: RootContainer = createRootContainer(sink);

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
    const tree = element === null ? null : createElement(StatusContext, { value: status }, element);
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
    status,
    render(element) {
      update(element);
    },
    flush,
    settle,
    unmount() {
      update(null);
    },
    liveIds(kind = 'container') {
      return [...container.live.values()].filter((i) => i.kind === kind).map((i) => i.id);
    },
  };
}

/** A sink that records every op in order. Handy for tests and dry runs. */
export function collectOps(): { ops: Op[]; batches: Op[][]; sink: OpSink; take(): Op[] } {
  const ops: Op[] = [];
  const batches: Op[][] = [];
  return {
    ops,
    batches,
    sink(batch) {
      batches.push([...batch]);
      ops.push(...batch);
    },
    take() {
      return ops.splice(0, ops.length);
    },
  };
}
