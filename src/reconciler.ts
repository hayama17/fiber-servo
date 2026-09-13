import type { ReactNode } from 'react';
import Reconciler from 'react-reconciler';
import { ConcurrentRoot } from 'react-reconciler/constants';
import { createRootContainer, typedHostConfig, type RootContainer } from './hostConfig.js';
import type { Op, OpSink } from './ops.js';

const reconciler = Reconciler(typedHostConfig);

export interface Root {
  /**
   * Render `element` as the desired state and flush synchronously.
   * When it returns, every op the commit produced has been handed to the sink.
   */
  render(element: ReactNode): void;
  /** Tear the tree down: emits DELETE for every live container. */
  unmount(): void;
  /** Ids of containers that currently have a CREATE outstanding, in tree order. */
  liveIds(): string[];
}

export interface CreateRootOptions {
  /** Receives one batch per commit. Defaults to no-op; use `collectOps` or a runtime. */
  sink?: OpSink;
  onUncaughtError?: (error: unknown) => void;
}

export function createRoot(options: CreateRootOptions = {}): Root {
  const sink = options.sink ?? (() => {});
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
    'react4c',
    onError,
    onError,
    onError,
    () => {},
  );

  function flush(element: ReactNode): void {
    reconciler.updateContainerSync(element, fiberRoot, null, null);
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

  return {
    render(element) {
      flush(element);
    },
    unmount() {
      flush(null);
    },
    liveIds() {
      return [...container.live.keys()];
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
