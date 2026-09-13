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

export interface RuntimeHandle {
  /** Receives one batch per commit. */
  sink: OpSink;
  /** Resolves once every batch received so far has been executed. */
  idle?(): Promise<void>;
  /** Long-running observer that feeds the status store; runs until `signal` aborts. */
  watch?(signal: AbortSignal): Promise<void>;
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

  return {
    root,
    status,
    async stop() {
      root.unmount();
      await handle.idle?.();
      stop.abort();
      await watching;
    },
  };
}
