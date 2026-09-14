/**
 * containerd, wired up as a `RuntimeFactory` for `serve()`. See `runtime.ts`
 * for what actually happens; this file only builds the two seams --
 * `nerdctl` for writes, `api` (a gRPC client) plus `cni` (CNI config reads)
 * for reads -- and hands them, plus the calling `RuntimeContext`, to
 * `createContainerdRuntime`.
 */
import type { RuntimeContext, RuntimeFactory } from '../types.js';
import { createNerdctl, type NerdctlOptions } from './nerdctl.js';
import { createContainerdApi } from './api.js';
import { DEFAULT_CNI_PATH } from './cni.js';
import { createContainerdRuntime } from './runtime.js';

export interface ContainerdOptions extends NerdctlOptions {
  /** Image for every Pod's sandbox container. Default: `DEFAULT_SANDBOX_IMAGE`. */
  sandboxImage?: string;
  /** Root of the CNI configuration tree networks are read from. Default `/etc/cni/net.d` (`cni.ts`'s own default). */
  cniPath?: string;
  /** How often the readiness prober looks for containers due for a check. Default 250. */
  probeTickMs?: number;
  /** Delay before reattaching a dead event stream, and the spacing of the resync fallback while it stays down. Default 1000. */
  reconnectDelayMs?: number;
}

/** containerd as a `Runtime` for `serve()`. */
export function containerd(options: ContainerdOptions = {}): RuntimeFactory {
  return (ctx: RuntimeContext) =>
    createContainerdRuntime({
      nerdctl: createNerdctl(options),
      api: createContainerdApi({ address: options.address, namespace: options.namespace }),
      cni: { cniPath: options.cniPath ?? DEFAULT_CNI_PATH, namespace: options.namespace },
      sandboxImage: options.sandboxImage,
      probeTickMs: options.probeTickMs,
      reconnectDelayMs: options.reconnectDelayMs,
      log: ctx.log,
      onError: ctx.onError,
    });
}

export { createContainerdRuntime } from './runtime.js';
export type { ContainerdRuntimeOptions } from './runtime.js';

export {
  createNerdctl,
  CONTAINER_LABEL,
  MANAGED_LABEL,
  POD_LABEL,
  ROLE_LABEL,
  SPEC_JSON_LABEL,
  SPEC_LABEL,
} from './nerdctl.js';
export type { ExecResult, Nerdctl, NerdctlOptions } from './nerdctl.js';

export {
  DEFAULT_SANDBOX_IMAGE,
  encodeSpecLabel,
  infraName,
  infraRunArgs,
  memberName,
  memberRunArgs,
  networkCreateArgs,
  updateResourcesArgs,
} from './naming.js';

export {
  decodeSpecLabel,
  derivePodPhase,
  phaseFromTask,
  reconstructPodSpec,
  toObservedContainer,
} from './parse.js';

export { createContainerdApi, DEFAULT_ADDRESS, DEFAULT_NAMESPACE } from './api.js';
export type {
  ApiContainer,
  ApiEvent,
  ApiTask,
  ApiTaskStatus,
  ContainerdApi,
  ContainerdApiOptions,
} from './api.js';

export { listNetworks, DEFAULT_CNI_PATH, BUILT_IN_NETWORKS } from './cni.js';
export type { CniOptions } from './cni.js';
