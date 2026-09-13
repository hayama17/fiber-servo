import type { Runtime } from '../../serve.js';
import { createContainerdRuntime } from './execute.js';
import { watchContainerd } from './events.js';
import { createNerdctl, type NerdctlOptions } from './nerdctl.js';

export { createNerdctl, MANAGED_LABEL, SPEC_LABEL } from './nerdctl.js';
export type { Nerdctl, NerdctlOptions, ExecResult } from './nerdctl.js';
export { createContainerdRuntime, runArgs, networkCreateArgs, specDigest } from './execute.js';
export type { ContainerdRuntime, ContainerdRuntimeOptions } from './execute.js';
export {
  watchContainerd,
  syncFromPs,
  interpretEvent,
  parsePsLine,
  parsePsStatus,
  isManaged,
} from './events.js';
export type { WatchOptions, StatusEvent, PsRow, EventRow } from './events.js';

export interface ContainerdOptions extends NerdctlOptions {
  /** How often the readiness prober looks for work. Default 250. */
  probeTickMs?: number;
}

/**
 * containerd as a `Runtime` for `serve()`: the executor, the event watcher
 * and the readiness prober, wired to one nerdctl and one id index.
 */
export function containerd(options: ContainerdOptions = {}): Runtime {
  return (ctx) => {
    const nerdctl = createNerdctl(options);
    const index = new Map<string, string>();
    const runtime = createContainerdRuntime({
      nerdctl,
      status: ctx.status,
      index,
      log: ctx.log,
      onError: (error) => ctx.onError(error),
      probeTickMs: options.probeTickMs,
    });
    // Resolved by the watcher's first `ps -a`; stays pending if that never
    // succeeds, which is what keeps a prune from running half-informed.
    let markSynced = (): void => {};
    const synced = new Promise<void>((resolve) => (markSynced = resolve));
    return {
      sink: runtime.sink,
      idle: runtime.idle,
      prune: runtime.prune,
      synced,
      async watch(signal) {
        await Promise.all([
          watchContainerd({
            nerdctl,
            status: ctx.status,
            index,
            signal,
            log: ctx.log,
            onError: ctx.onError,
            onSynced: markSynced,
          }),
          runtime.probe(signal),
        ]);
      },
    };
  };
}
