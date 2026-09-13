/**
 * The one-call entry point: a tree, a runtime, done.
 *
 * `serve()` wires what `createRoot` leaves to the caller: the status store,
 * the runtime's sink, its event watcher, and an orderly stop. Runtimes stay
 * outside the tree (design rule #2); this only makes plugging one in a
 * single line.
 */
import type { ReactNode } from 'react';
import type { Op, OpSink } from './ops.js';
import { createRoot, type Root } from './reconciler.js';
import { createStatusStore, type StatusStore } from './status.js';

export interface RuntimeContext {
  status: StatusStore;
  log: (line: string) => void;
  onError: (error: Error) => void;
}

/** What the tree declares right now, by resource kind. Everything else managed is garbage. */
export interface PruneKeep {
  containers: readonly string[];
  networks: readonly string[];
}

export interface RuntimeHandle {
  /** Receives one batch per commit. */
  sink: OpSink;
  /** Resolves once every batch received so far has been executed. */
  idle?(): Promise<void>;
  /** Long-running observer that feeds the status store; runs until `signal` aborts. */
  watch?(signal: AbortSignal): Promise<void>;
  /**
   * Resolves once `watch()` has reflected what already exists into the status
   * store. Pruning waits for it, because adopted containers are what open the
   * tree's gates (decision 20).
   */
  synced?: Promise<void>;
  /** Remove managed resources absent from `keep`; resolves with the names removed. */
  prune?(keep: PruneKeep): Promise<string[]>;
}

/** Binds a runtime to a status store. `containerd()` and `dummy()` are the built-in ones. */
export type Runtime = (ctx: RuntimeContext) => RuntimeHandle;

export interface ServeOptions {
  runtime: Runtime;
  status?: StatusStore;
  log?: (line: string) => void;
  onError?: (error: Error) => void;
  /** Observe each batch before the runtime gets it. */
  onOps?: (ops: readonly Op[]) => void;
  /**
   * Delete managed resources the tree does not declare, once the runtime has
   * synced and the tree has settled. Default `true`.
   */
  prune?: boolean;
}

export interface Served {
  root: Root;
  status: StatusStore;
  /** Unmount (DELETE everything), let the runtime finish, stop watching. */
  stop(): Promise<void>;
}

export function serve(element: ReactNode, options: ServeOptions): Served {
  const status = options.status ?? createStatusStore();
  const log = options.log ?? (() => {});
  const onError = options.onError ?? ((e: Error) => console.error(e));
  const handle = options.runtime({ status, log, onError });

  const root = createRoot({
    status,
    sink: (ops) => {
      options.onOps?.(ops);
      handle.sink(ops);
    },
  });

  const stop = new AbortController();
  const watching = handle.watch ? handle.watch(stop.signal).catch(onError) : Promise.resolve();

  root.render(element);

  let stopped = false;
  if (options.prune !== false && handle.prune) {
    // Order matters: the watcher's first sync reports adopted containers
    // running, settle() then lets every gate that opens declare its subtree,
    // and only what the tree still does not name is garbage (decision 20).
    void (async () => {
      await handle.synced;
      await root.settle();
      if (stopped) return; // a stop() in between unmounted the tree: nothing is declared, prune nothing
      const removed = await handle.prune?.({
        containers: root.liveIds('container'),
        networks: root.liveIds('network'),
      });
      if (removed?.length) log(`pruned ${removed.join(' ')}`);
    })().catch(onError);
  }

  return {
    root,
    status,
    async stop() {
      stopped = true;
      root.unmount();
      await handle.idle?.();
      stop.abort();
      await watching;
    },
  };
}
