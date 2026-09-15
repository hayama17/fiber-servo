/**
 * The planner: desired state in, a human-readable plan out.
 *
 * This file used to decide whether a changed field meant nothing, an update
 * in place, or a replacement — the entire immutability model lived here, and
 * it was the reason no layer above it ever said `stop`, `delete` or `start`.
 *
 * That decision no longer belongs to fiber-servo at all. The write path is
 * now a Compose Application Model handed whole to an actuator
 * (`Runtime.apply`, see `runtime/types.ts`): the actuator is the one thing
 * that knows how `nerdctl compose` actually behaves, so it is the one thing
 * that gets to decide what a changed spec means. Concretely, under Compose
 * there is no live-update primitive fiber-servo can reach: the old
 * "`resources` is the one mutable field, updated in place" branch is gone
 * along with the rest of the model, because the response to *any* spec
 * difference — cpu and memory included — is now uniformly "this service's
 * `fiber-servo.spec` label digest changed, so remove it and let `compose up`
 * recreate it." A reader who remembers the old in-place-resources path and
 * comes looking for where it went: it did not move, it was retired, because
 * Compose gave fiber-servo nowhere to put it.
 *
 * What is left for this file to do is purely informational: given a desired
 * container/network set and what is currently observed, report what
 * `Runtime.apply` is *about to* do, for `fiber-servo plan` and for logging.
 * It builds the same `ComposeApplication` the control loop is about to hand
 * to the runtime and diffs it against recorded spec digests using
 * `compose.ts`'s own `changedServices`/`orphanedServices` — the exact
 * comparison the write path itself is built on, so this file's answer can
 * never drift from what actually happens.
 */
import {
  DEFAULT_PROJECT,
  MANAGED_LABEL,
  SPEC_LABEL,
  changedServices,
  orphanedServices,
  toComposeApplication,
  type ComposeApplication,
} from './compose.js';
import type { ContainerSpec, NetworkSpec } from './resources.js';
import type { ObservedState } from './runtime/types.js';

/**
 * What applying the desired state would do, reported rather than decided:
 * `Runtime.apply` is what actually creates, replaces or removes anything.
 */
export interface Plan {
  /** The Compose Application Model the control loop is about to hand to `Runtime.apply`. */
  model: ComposeApplication;
  /** Services that exist with a different spec digest than desired — will be replaced. */
  changed: readonly string[];
  /** Managed services the model no longer declares — will be removed. */
  orphaned: readonly string[];
  /** Desired services that do not exist yet — will be created. */
  missing: readonly string[];
  /**
   * Services present with the *same* spec digest, but currently `exited` —
   * will be restarted. This is not a `changedServices`/`orphanedServices`
   * question at all: nothing about the desired spec differs, so a digest
   * comparison alone reports these as neither missing nor changed. It is
   * `Runtime.apply`'s own idempotence contract (see `runtime/memory.ts`)
   * that treats "same spec, but exited" as needing a restart, so this list
   * is built by asking observed phase directly, the one thing a spec digest
   * can never encode.
   */
  restarting: readonly string[];
}

/**
 * Which recorded services `changedServices`/`orphanedServices` are even
 * allowed to have an opinion about: only containers fiber-servo can prove it
 * made. A container with no `fiber-servo.spec` digest at all — unmanaged, or
 * adopted from outside — must never be reported as "will be removed" just
 * because the tree does not mention it; that is the same "don't touch what
 * we can't prove we made" rule the old planner applied to a Pod with no
 * recorded spec or digest.
 */
function recordedSpecDigests(observed: ObservedState): Map<string, string> {
  const recorded = new Map<string, string>();
  for (const container of observed.containers.values()) {
    if (container.labels[MANAGED_LABEL] !== 'true') continue;
    const digest = container.specDigest ?? container.labels[SPEC_LABEL];
    if (digest !== undefined) recorded.set(container.name, digest);
  }
  return recorded;
}

/**
 * Build the desired Compose model and report what applying it would change,
 * against what is currently observed. Pure and synchronous, like the
 * controllers this sits downstream of — it makes no runtime calls itself.
 */
export function planApply(
  desired: { networks: readonly NetworkSpec[]; containers: readonly ContainerSpec[] },
  observed: ObservedState,
  project: string = DEFAULT_PROJECT,
): Plan {
  const model = toComposeApplication(desired.containers, desired.networks, project);
  const recorded = recordedSpecDigests(observed);
  const changed = changedServices(model, recorded);
  const orphaned = orphanedServices(model, recorded);
  const missing = Object.keys(model.services)
    .filter((name) => !recorded.has(name))
    .sort();
  const changedOrMissing = new Set([...changed, ...missing]);
  const restarting = Object.keys(model.services)
    .filter((name) => !changedOrMissing.has(name) && recorded.has(name))
    .filter((name) => observed.containers.get(name)?.phase === 'exited')
    .sort();
  return { model, changed, orphaned, missing, restarting };
}

/**
 * True when applying this plan would change nothing.
 *
 * The control loop uses it to skip the `apply` call entirely — recomputing
 * the plan is exactly how the runtime itself would answer "does anything need
 * to change", so a whole `nerdctl compose up` invocation would only prove
 * what this already proves for free. Callers logging plans want the same
 * question, which is why it is exported rather than being an inline sum.
 */
export function planIsEmpty(plan: Plan): boolean {
  return (
    plan.missing.length === 0 &&
    plan.changed.length === 0 &&
    plan.orphaned.length === 0 &&
    plan.restarting.length === 0
  );
}

// ---- rendering ---------------------------------------------------------------

/** One line per pending change, for `fiber-servo plan`, logs and test failure messages. */
export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  for (const name of plan.missing) {
    lines.push(`create ${name} image=${plan.model.services[name]?.image ?? '?'}`);
  }
  for (const name of plan.changed) lines.push(`replace ${name}`);
  for (const name of plan.restarting) lines.push(`restart ${name}`);
  for (const name of plan.orphaned) lines.push(`remove ${name}`);
  return lines.length > 0 ? lines.join('\n') : '(nothing to do)';
}
