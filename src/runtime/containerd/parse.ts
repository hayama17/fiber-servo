/**
 * Pure translation from containerd API data to fiber-servo types: a task's
 * status to a `ContainerPhase`, nerdctl's networks label to a string array, a
 * container's labels to an `ObservedContainer`.
 *
 * Nothing here calls the API; `runtime.ts` is the only file that does, and it
 * is built almost entirely out of calls into this one plus decisions about
 * which call to make next. Keeping the translation pure is what lets it be
 * exercised with literal values in and literal objects out.
 */
import type { ApiContainer, ApiTask } from './api.js';
import type { ContainerPhase, ObservedContainer } from '../types.js';
import { COMPOSE_SERVICE_LABEL, NERDCTL_NETWORKS_LABEL, SPEC_LABEL } from '../../compose.js';

/**
 * A container's phase and exit code, from its task -- or the lack of one.
 *
 * `stopped` is the only status a task reports an exit code for (see `toTask`
 * in `api.ts`); a container with no task at all -- never started, or its task
 * already cleaned up -- reads the same way, `exited`, because that is the
 * only phase left once nothing is running. `pausing` is folded into `waiting`
 * along with `paused`: both describe a task that is up but not currently
 * doing the work a "running" container is expected to.
 */
export function phaseFromTask(task: ApiTask | undefined): { phase: ContainerPhase; exitCode?: number } {
  if (!task || task.status === 'stopped') return { phase: 'exited', exitCode: task?.exitStatus };
  switch (task.status) {
    case 'running':
      return { phase: 'running' };
    case 'created':
    case 'paused':
    case 'pausing':
      return { phase: 'waiting' };
    default:
      return { phase: 'unknown' };
  }
}

/**
 * `nerdctl/networks` is a JSON array of network names, e.g. `["backend"]`
 * (verified against nerdctl 2.1.2's own container labels) -- not the
 * comma-joined list `nerdctl ps`'s `Labels` column would suggest. A label
 * this project did not write -- absent, or corrupted by something outside
 * nerdctl -- must not crash a resync, so a bad value reads as "no networks"
 * rather than throwing.
 */
function parseNetworksLabel(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** One containerd row, with its task, as the control plane sees it. */
export function toObservedContainer(
  container: ApiContainer,
  task: ApiTask | undefined,
  ready: boolean | undefined,
  at: number,
): ObservedContainer {
  const { phase, exitCode } = phaseFromTask(task);
  return {
    name: container.labels[COMPOSE_SERVICE_LABEL] ?? container.id,
    id: container.id,
    phase,
    exitCode,
    ready,
    image: container.image || undefined,
    networks: parseNetworksLabel(container.labels[NERDCTL_NETWORKS_LABEL]),
    labels: container.labels,
    specDigest: container.labels[SPEC_LABEL],
    at,
  };
}

// ---- readiness -------------------------------------------------------------
//
// The probe rides in `ComposeService.labels` under `READINESS_LABEL`, because
// nothing else in the `Runtime` contract could carry it: `apply()` receives a
// `ComposeApplication` and nothing more. `compose.ts` owns that convention
// (it is the file that writes the label); this adapter only reads it back --
// off the *model* for a service about to be applied, and off a *running
// container* when recovering a schedule after a restart.
export { READINESS_LABEL, decodeReadiness } from '../../compose.js';
