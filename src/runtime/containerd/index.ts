/**
 * containerd, wired up as a `RuntimeFactory` for `serve()`. See `runtime.ts`
 * for what actually happens; this file only builds the two seams -- `nerdctl`
 * for the write path (`compose`), `api` (a gRPC client) for the read path --
 * and hands them, plus the calling `RuntimeContext`, to `createContainerdRuntime`.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeContext, RuntimeFactory } from '../types.js';
import { DEFAULT_PROJECT } from '../../compose.js';
import { createNerdctl, type NerdctlOptions } from './nerdctl.js';
import { createContainerdApi, DEFAULT_ADDRESS, DEFAULT_NAMESPACE } from './api.js';
import { createContainerdRuntime } from './runtime.js';

/** Where `apply` renders the model, and `down` reads it back from, if `composeFile` is not given. */
export const DEFAULT_COMPOSE_FILE = join(tmpdir(), 'fiber-servo', 'compose.json');

export interface ContainerdOptions extends NerdctlOptions {
  /**
   * The Compose project this adapter manages. Normally left unset: `serve()`
   * passes its own project down through `RuntimeContext`, so there is one
   * place to set it. Set it here only when driving the adapter directly,
   * without `serve()`.
   */
  project?: string;
  /** Stable path the rendered model is written to and `down` is applied against. Default `DEFAULT_COMPOSE_FILE`. */
  composeFile?: string;
  /** How often the readiness prober looks for containers due for a check. Default 250. */
  probeTickMs?: number;
  /** Delay before reattaching a dead event stream, and the spacing of the resync fallback while it stays down. Default 1000. */
  reconnectDelayMs?: number;
}

/** containerd as a `Runtime` for `serve()`. */
export function containerd(options: ContainerdOptions = {}): RuntimeFactory {
  // Namespace scopes both halves of this adapter -- nerdctl's `--namespace`
  // flag and containerd's own gRPC metadata (`api.ts`) -- and it has to be
  // the exact same string on both sides, or writes and reads would silently
  // talk to two different containerd namespaces. Computing it once here,
  // rather than letting each seam fall back to its own default independently,
  // is what guarantees that.
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  return (ctx: RuntimeContext) =>
    createContainerdRuntime({
      nerdctl: createNerdctl({ bin: options.bin, namespace, address: options.address }),
      api: createContainerdApi({ address: options.address, namespace }),
      project: options.project ?? ctx.project ?? DEFAULT_PROJECT,
      composeFile: options.composeFile ?? DEFAULT_COMPOSE_FILE,
      probeTickMs: options.probeTickMs,
      reconnectDelayMs: options.reconnectDelayMs,
      log: ctx.log,
      onError: ctx.onError,
    });
}

export { createContainerdRuntime } from './runtime.js';
export type { ContainerdRuntimeOptions } from './runtime.js';

export { createNerdctl } from './nerdctl.js';
export type { ExecResult, Nerdctl, NerdctlOptions } from './nerdctl.js';

export { phaseFromTask, READINESS_LABEL, toObservedContainer } from './parse.js';

export { createContainerdApi, DEFAULT_ADDRESS, DEFAULT_NAMESPACE } from './api.js';
export type {
  ApiContainer,
  ApiEvent,
  ApiTask,
  ApiTaskStatus,
  ContainerdApi,
  ContainerdApiOptions,
} from './api.js';
