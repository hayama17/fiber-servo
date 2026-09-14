/**
 * Pure argv construction: spec -> `nerdctl` command line, and the one place
 * that decides what a Pod's resources are called on the containerd side.
 *
 * Nothing here touches a process. Every function is a straight `Spec -> argv`
 * or `Spec -> string` mapping, which is what makes the argv assertions in
 * `test/containerd.test.ts` read as documentation instead of mocks.
 */
import type { ContainerSpec, NetworkSpec, PodSpec, ResourceLimits } from '../../resources.js';
import { digest } from '../../resources.js';
import {
  CONTAINER_LABEL,
  MANAGED_LABEL,
  POD_LABEL,
  ROLE_LABEL,
  SPEC_JSON_LABEL,
  SPEC_LABEL,
} from './nerdctl.js';

/**
 * containerd has no Pod. What CRI does, and what this adapter does too, is
 * fake one out of two containerd primitives it already has:
 *
 *   - an "infra" (a.k.a. sandbox) container that owns the network namespace
 *     and nothing else -- it just has to stay alive;
 *   - the Pod's real containers, each started sharing that namespace via
 *     `--network=container:<infra>` instead of getting one of their own.
 *
 * The infra container is named after the Pod itself (`infraName`), so
 * `nerdctl ps` shows one row per Pod at a glance; members are named
 * `<pod>-<container>` (`memberName`) so the family relationship is legible
 * too, without needing the labels to read it. This file is the one place
 * that owns that mapping -- nothing outside it ever assembles a runtime name
 * by hand.
 *
 * The consequence that matters most operationally: a host port can only be
 * published on the container that owns the network namespace. Once a
 * container joins one with `--network=container:X`, `nerdctl` refuses `-p` on
 * it -- the namespace, and therefore the port table, belongs to `X`. So
 * `PodTemplate.publish` is applied to the infra container's `run` (see
 * `infraRunArgs`), never to a member's, regardless of which member's process
 * actually listens on that port.
 */
export function infraName(pod: string): string {
  return pod;
}

/** Runtime-side name of one member container. The one mapping this adapter uses; see the file doc. */
export function memberName(pod: string, container: string): string {
  return `${pod}-${container}`;
}

/**
 * What the sandbox runs. It only has to hold a network namespace open, so it
 * never needs pulling more than once and never needs a command: `pause`'s
 * entrypoint already does nothing forever. Overridable (`sandboxImage`
 * option) for a test image or a mirror.
 */
export const DEFAULT_SANDBOX_IMAGE = 'registry.k8s.io/pause:3.9';

/** Percent-encoded JSON, so a value with commas survives `nerdctl ps`'s comma-joined `Labels` column intact. */
export function encodeSpecLabel(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

function labelFlags(labels: Readonly<Record<string, string>> | undefined): string[] {
  const args: string[] = [];
  for (const [k, v] of Object.entries(labels ?? {})) args.push('--label', `${k}=${v}`);
  return args;
}

/**
 * argv for the sandbox's `nerdctl run`. Restarts are ours (`--restart=no`,
 * same reasoning as everywhere else in this project: a restart is the tree's
 * decision, not containerd's). Port publishing lives here and only here --
 * see the file doc.
 */
export function infraRunArgs(spec: PodSpec, sandboxImage: string = DEFAULT_SANDBOX_IMAGE): string[] {
  const args = [
    'run',
    '-d',
    '--name',
    infraName(spec.name),
    '--restart=no',
    '--pull=missing',
    '--label',
    `${MANAGED_LABEL}=true`,
    '--label',
    `${SPEC_LABEL}=${digest(spec)}`,
    '--label',
    `${SPEC_JSON_LABEL}=${encodeSpecLabel(spec)}`,
    '--label',
    `${POD_LABEL}=${spec.name}`,
    '--label',
    `${ROLE_LABEL}=infra`,
  ];
  if (spec.network) args.push('--network', spec.network);
  for (const p of spec.publish ?? []) {
    args.push('-p', `${p.host}:${p.target}${p.protocol && p.protocol !== 'tcp' ? `/${p.protocol}` : ''}`);
  }
  args.push(...labelFlags(spec.labels));
  args.push(sandboxImage);
  return args;
}

/**
 * argv for one member's `nerdctl run`. `--network=container:<infra>` is
 * written as one token on purpose: it is the single most important line in
 * this file, and a reader grepping for "how does a member join its Pod"
 * should find one unambiguous string, not a flag that happens to be followed
 * by the right value two tokens later.
 */
export function memberRunArgs(pod: string, spec: ContainerSpec): string[] {
  const args = [
    'run',
    '-d',
    '--name',
    memberName(pod, spec.name),
    '--restart=no',
    '--pull=missing',
    '--label',
    `${MANAGED_LABEL}=true`,
    '--label',
    `${SPEC_LABEL}=${digest(spec)}`,
    '--label',
    `${SPEC_JSON_LABEL}=${encodeSpecLabel(spec)}`,
    '--label',
    `${POD_LABEL}=${pod}`,
    '--label',
    `${CONTAINER_LABEL}=${spec.name}`,
    '--label',
    `${ROLE_LABEL}=member`,
    `--network=container:${infraName(pod)}`,
  ];
  // Initial limits, if the spec asked for any -- the same flags
  // `updateResourcesArgs` uses later, so a container's resources are always
  // whatever containerd itself reports, never a value only this process
  // remembers (see "the recorded spec" in `runtime.ts`).
  if (spec.resources?.cpu !== undefined) args.push('--cpus', String(spec.resources.cpu));
  if (spec.resources?.memory !== undefined) args.push('--memory', spec.resources.memory);
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push('-e', `${k}=${v}`);
  args.push(spec.image, ...(spec.command ?? []));
  return args;
}

/** argv for `nerdctl network create`. */
export function networkCreateArgs(spec: NetworkSpec): string[] {
  const args = ['network', 'create', '--label', `${MANAGED_LABEL}=true`];
  if (spec.subnet) args.push('--subnet', spec.subnet);
  args.push(...labelFlags(spec.labels));
  args.push(spec.name);
  return args;
}

/**
 * argv for `nerdctl update`: the one in-place mutation in the whole system
 * (see `PLAN.md`'s immutability model). Everything else about a container
 * replaces it; cpu/memory do not have to, because cgroups can change under a
 * running process.
 */
export function updateResourcesArgs(pod: string, container: string, resources: ResourceLimits): string[] {
  const args = ['update'];
  if (resources.cpu !== undefined) args.push('--cpus', String(resources.cpu));
  if (resources.memory !== undefined) args.push('--memory', resources.memory);
  args.push(memberName(pod, container));
  return args;
}
