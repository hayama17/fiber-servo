/**
 * Pure translation from containerd API data to fiber-servo types: a task's
 * status to a `ContainerPhase`, a percent-encoded label back to the spec it
 * came from, a Pod's phase from its containers'.
 *
 * Nothing here calls the API; `runtime.ts` is the only file that does, and it
 * is built almost entirely out of calls into this one plus decisions about
 * which call to make next. Keeping the translation pure is what lets it be
 * exercised with literal values in and literal objects out, same discipline
 * as before this module moved off text parsing.
 */
import type { ApiContainer, ApiTask } from './api.js';
import type { ContainerSpec, PodSpec } from '../../resources.js';
import type { ContainerPhase, ObservedContainer, PodPhase } from '../types.js';
import { CONTAINER_LABEL, SPEC_JSON_LABEL } from './nerdctl.js';

/** The inverse of `encodeSpecLabel` in `naming.ts`. */
export function decodeSpecLabel<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(decodeURIComponent(value)) as T;
  } catch {
    return undefined; // a foreign or corrupt label must not crash a resync
  }
}

/**
 * A container's phase and exit code, from its task -- or the lack of one.
 *
 * `stopped` is the only status a task reports an exit code for (see
 * `toTask` in `api.ts`); a container with no task at all -- never started,
 * or its task already cleaned up after `rm` -- reads the same way, `exited`,
 * because that is the only phase left once nothing is running. `pausing` is
 * folded into `waiting` along with `paused`: both describe a task that is up
 * but not currently doing the work a "running" container is expected to.
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

export function toObservedContainer(
  container: ApiContainer,
  task: ApiTask | undefined,
  ready: boolean | undefined,
): ObservedContainer {
  const { phase, exitCode } = phaseFromTask(task);
  return {
    name: container.labels[CONTAINER_LABEL] ?? container.id,
    id: container.id,
    phase,
    exitCode,
    ready,
    image: container.image || undefined,
  };
}

/**
 * `ObservedPod.phase`, per the contract in `types.ts`: running once the
 * sandbox and every container are up, exited once the sandbox is gone or
 * every container has stopped, unknown if any part of the picture is. The
 * sandbox is not one of `containers` (it never appears in `PodSpec.containers`
 * either), so it is passed in separately rather than folded into the list.
 */
export function derivePodPhase(sandbox: ContainerPhase, containers: readonly ObservedContainer[]): PodPhase {
  if (sandbox === 'exited') return 'exited'; // the sandbox owns the namespace; gone means the Pod is gone
  if (sandbox === 'unknown' || containers.some((c) => c.phase === 'unknown')) return 'unknown';
  if (containers.length === 0) return 'pending'; // sandbox up, nothing scheduled into it yet
  if (sandbox === 'running' && containers.every((c) => c.phase === 'running')) return 'running';
  if (containers.every((c) => c.phase === 'exited')) return 'exited';
  return 'pending';
}

// ---- the recorded spec ---------------------------------------------------------
//
// `ObservedPod.spec` lets the planner tell an in-place change (cpu/memory)
// from one that forces a replacement (image/command/env), even after a
// restart -- see `types.ts`. Labels are the only place containerd offers to
// keep it, but labels cannot be *rewritten* once a container exists, so this
// adapter never tries to: it stores each resource's own spec once, at the
// moment that exact resource is created, and reconstructs the Pod's current
// spec by combining whichever labels are still attached to whichever
// containers currently exist. `createContainer`/`removeContainer` change
// which members exist, which is exactly the input this recombines from, so
// nothing has to be rewritten for the result to stay truthful.
//
// `resources` used to be the one exception, overlaid from a *live* cgroup
// read after `updateContainerResources` so an in-place resize would not go
// stale between the label and reality. That overlay is gone: `ApiContainer`
// (`api.ts`) carries only id/image/labels, nothing about cgroups, and this
// adapter's mandate keeps reads off `nerdctl` everywhere but the Pod IP (see
// `runtime.ts`'s file doc), so there is no source left to read it from. The
// value this reconstructs after a resource update is therefore what the
// container was *created* with, not its current cgroup limits, until the Pod
// is replaced. This is a real, known gap, not an oversight -- and, in
// practice, not a regression either: the `nerdctl inspect` field the old
// overlay read (`HostConfig.NanoCpus`) does not exist in nerdctl 2.1.2's
// output at all (verified against a real daemon), so that inspect call
// always failed and the overlay was already silently a no-op.

export function reconstructPodSpec(
  template: PodSpec | undefined,
  memberRows: readonly ApiContainer[],
): PodSpec | undefined {
  if (!template) return undefined;
  const containers: ContainerSpec[] = [];
  for (const row of memberRows) {
    const spec = decodeSpecLabel<ContainerSpec>(row.labels[SPEC_JSON_LABEL]);
    if (spec) containers.push(spec);
  }
  return { ...template, containers };
}
