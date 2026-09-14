/**
 * Pure translation from `nerdctl` text to fiber-servo types: `ps` rows,
 * `events` lines, label strings. Nothing here calls `nerdctl`; `runtime.ts`
 * is the only file that does, and it is built almost entirely out of calls
 * into this one plus decisions about which call to make next.
 *
 * Keeping the parsing pure is what lets `test/containerd.test.ts` assert on
 * it directly, with literal strings in and literal objects out, instead of
 * driving a fake process just to exercise a regex.
 */
import type { ContainerSpec, PodSpec, ResourceLimits } from '../../resources.js';
import type { ContainerPhase, PodPhase, ObservedContainer } from '../types.js';
import {
  CONTAINER_LABEL,
  MANAGED_LABEL,
  POD_LABEL,
  ROLE_LABEL,
  SPEC_JSON_LABEL,
  SPEC_LABEL,
} from './nerdctl.js';

export function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The inverse of `encodeSpecLabel` in `naming.ts`. */
export function decodeSpecLabel<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(decodeURIComponent(value)) as T;
  } catch {
    return undefined; // a foreign or corrupt label must not crash a resync
  }
}

// ---- labels -----------------------------------------------------------------

export function isManaged(labels: string | undefined): boolean {
  return (labels ?? '').split(',').some((kv) => kv.trim() === `${MANAGED_LABEL}=true`);
}

/** One `k=v` lookup in `nerdctl`'s comma-joined `Labels` column. */
export function labelValue(labels: string | undefined, key: string): string | undefined {
  for (const kv of (labels ?? '').split(',')) {
    const trimmed = kv.trim();
    const eq = trimmed.indexOf('=');
    if (eq !== -1 && trimmed.slice(0, eq) === key) return trimmed.slice(eq + 1);
  }
  return undefined;
}

const RESERVED_LABELS: ReadonlySet<string> = new Set([
  MANAGED_LABEL,
  SPEC_LABEL,
  SPEC_JSON_LABEL,
  POD_LABEL,
  CONTAINER_LABEL,
  ROLE_LABEL,
]);

/** `spec.labels` as the caller wrote them, stripped of everything this adapter adds for its own bookkeeping. */
export function userLabels(labels: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of (labels ?? '').split(',')) {
    const trimmed = kv.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    if (!RESERVED_LABELS.has(key)) out[key] = trimmed.slice(eq + 1);
  }
  return out;
}

// ---- `ps -a` ------------------------------------------------------------------

/** `Up 3 seconds` -> running; `Exited (137) ...` -> exited, 137; `Created` -> waiting; anything else -> unknown. */
export function parsePsPhase(text: string): { phase: ContainerPhase; exitCode?: number } {
  const s = text.trim();
  if (/^(Up|Running|Paused)\b/i.test(s)) return { phase: 'running' };
  const exited = /^Exited \((-?\d+)\)/i.exec(s);
  if (exited) return { phase: 'exited', exitCode: Number(exited[1]) };
  if (/^(Exited|Stopped|Dead)\b/i.test(s)) return { phase: 'exited' };
  if (/^Created\b/i.test(s)) return { phase: 'waiting' };
  return { phase: 'unknown' };
}

/** The docker-compatible enum `nerdctl inspect --format '{{.State.Status}}'` prints. */
export function phaseFromStateStatus(status: string): ContainerPhase {
  switch (status.trim().toLowerCase()) {
    case 'running':
    case 'paused':
      return 'running';
    case 'created':
      return 'waiting';
    case 'exited':
    case 'dead':
      return 'exited';
    default:
      return 'unknown';
  }
}

/** One row of `nerdctl ps -a --format '{{json .}}'`. */
export interface PsRow {
  ID: string;
  Names: string;
  Image?: string;
  Status: string;
  Labels?: string;
}

/** A `PsRow` that carries our labels, already picked apart. */
export interface ManagedRow {
  id: string;
  /** The runtime-side name: `infraName`/`memberName` from `naming.ts`. */
  name: string;
  pod: string;
  role: 'infra' | 'member';
  /** The container's name *within* the Pod. Only set for members. */
  container?: string;
  image?: string;
  phase: ContainerPhase;
  exitCode?: number;
  specDigest?: string;
  /** Raw (still percent-encoded) `SPEC_JSON_LABEL` value; decode with `decodeSpecLabel`. */
  specJson?: string;
  labels: Record<string, string>;
}

/** `null` for anything not carrying `fiber-servo.managed=true` with a recognisable Pod/role -- i.e. not ours. */
export function parsePsRow(line: string): ManagedRow | null {
  const row = parseJsonSafe<PsRow>(line);
  if (!row?.Names || !isManaged(row.Labels)) return null;
  const pod = labelValue(row.Labels, POD_LABEL);
  const role = labelValue(row.Labels, ROLE_LABEL);
  if (!pod || (role !== 'infra' && role !== 'member')) return null;
  const { phase, exitCode } = parsePsPhase(row.Status ?? '');
  return {
    id: row.ID,
    name: row.Names.split(',')[0]!.trim(),
    pod,
    role,
    container: role === 'member' ? labelValue(row.Labels, CONTAINER_LABEL) : undefined,
    image: row.Image,
    phase,
    exitCode,
    specDigest: labelValue(row.Labels, SPEC_LABEL),
    specJson: labelValue(row.Labels, SPEC_JSON_LABEL),
    labels: userLabels(row.Labels),
  };
}

export function toObservedContainer(row: ManagedRow, ready: boolean | undefined): ObservedContainer {
  return {
    name: row.container ?? row.name,
    id: row.id,
    phase: row.phase,
    exitCode: row.exitCode,
    ready,
    image: row.image,
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
// nothing has to be rewritten for the result to stay truthful. `resources` is
// the one exception: `updateContainerResources` changes cgroups on a container
// whose label was written before that update, so its value would go stale --
// this reads the *live* cgroup limits back from containerd instead of ever
// trusting the label for that one field.

export function nanoCpusToCpu(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return n > 0 ? n / 1e9 : undefined;
}

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const KiB = 1024;

/** Best-effort inverse of the `512m` / `2g` strings `ResourceLimits.memory` holds; containerd only ever hands back bytes. */
export function bytesToMemory(raw: string | undefined): string | undefined {
  const n = Number(raw);
  if (!(n > 0)) return undefined;
  if (n % GiB === 0) return `${n / GiB}g`;
  if (n % MiB === 0) return `${n / MiB}m`;
  if (n % KiB === 0) return `${n / KiB}k`;
  return String(n);
}

/**
 * The Pod's current `PodSpec`, or `undefined` when `infraRow` carries no spec
 * label at all (a Pod this adapter did not create, or one made by a version
 * that did not record one -- the planner is expected to fall back to
 * `specDigest` then, per `types.ts`).
 *
 * A member without its own label is dropped rather than failing the whole
 * reconstruction: better to under-report one container than to make the
 * entire Pod's spec disappear over it.
 */
export function reconstructPodSpec(
  infraRow: ManagedRow | undefined,
  memberRows: readonly ManagedRow[],
  liveResources: ReadonlyMap<string, ResourceLimits>,
): PodSpec | undefined {
  const template = decodeSpecLabel<PodSpec>(infraRow?.specJson);
  if (!template) return undefined;
  const containers: ContainerSpec[] = [];
  for (const row of memberRows) {
    const spec = decodeSpecLabel<ContainerSpec>(row.specJson);
    if (!spec) continue;
    const resources = liveResources.get(row.name) ?? spec.resources;
    containers.push(resources ? { ...spec, resources } : spec);
  }
  return { ...template, containers };
}

// ---- `events` -----------------------------------------------------------------

/** One line of `nerdctl events --format '{{json .}}'`. */
export interface EventRow {
  ID: string;
  Topic: string;
  /** The containerd event body. `nerdctl` has been seen to hand this over as either a JSON string or an object. */
  Event?: string | Record<string, unknown>;
}

export type ContainerdEvent =
  | { kind: 'started'; id: string }
  | { kind: 'exited'; id: string; exitCode: number }
  | { kind: 'deleted'; id: string };

/**
 * Maps a containerd topic to what happened, addressed by the container's
 * 64-hex id -- resolving that id to a Pod/container name is `runtime.ts`'s
 * job, since it needs the live id index to do it.
 */
export function interpretEventRow(row: EventRow): ContainerdEvent | null {
  const body =
    typeof row.Event === 'string'
      ? (parseJsonSafe<Record<string, unknown>>(row.Event) ?? {})
      : (row.Event ?? {});
  const id = String(body['container_id'] ?? body['id'] ?? row.ID ?? '');
  if (!id) return null;
  switch (row.Topic) {
    case '/tasks/start':
      return { kind: 'started', id };
    case '/tasks/exit': {
      // Exec processes exit too; only the init process (id == container_id) is the container itself.
      const pid = body['id'];
      if (pid !== undefined && pid !== body['container_id']) return null;
      return { kind: 'exited', id, exitCode: Number(body['exit_status'] ?? 0) };
    }
    case '/containers/delete':
      return { kind: 'deleted', id };
    default:
      return null;
  }
}
