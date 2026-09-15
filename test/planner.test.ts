import { describe, expect, it } from 'vitest';
import { MANAGED_LABEL, SPEC_LABEL, toComposeApplication } from '../src/compose.js';
import { formatPlan, planApply } from '../src/planner.js';
import { digest, type ContainerSpec } from '../src/resources.js';
import type { ObservedContainer, ObservedState } from '../src/runtime/types.js';

function container(overrides: Partial<ObservedContainer> = {}): ObservedContainer {
  return {
    name: 'app',
    phase: 'running',
    networks: [],
    labels: {},
    at: 1,
    ...overrides,
  };
}

function observedOf(...containers: ObservedContainer[]): ObservedState {
  return { containers: new Map(containers.map((c) => [c.name, c])), revision: 0 };
}

const EMPTY: ObservedState = { containers: new Map(), revision: 0 };

/** A container observed exactly as the memory/containerd adapters would record one fiber-servo created. */
function managed(spec: ContainerSpec, overrides: Partial<ObservedContainer> = {}): ObservedContainer {
  return container({
    name: spec.name,
    specDigest: digest(spec),
    labels: { [MANAGED_LABEL]: 'true', [SPEC_LABEL]: digest(spec) },
    ...overrides,
  });
}

const app: ContainerSpec = { name: 'app', image: 'app:1' };

describe('planApply', () => {
  it('an empty observed state: everything desired is missing, nothing changed or orphaned', () => {
    const plan = planApply({ networks: [], containers: [app] }, EMPTY);
    expect(plan.missing).toEqual(['app']);
    expect(plan.changed).toEqual([]);
    expect(plan.orphaned).toEqual([]);
    expect(plan.model.services['app']?.image).toBe('app:1');
  });

  it('a container present with the same digest: neither missing nor changed', () => {
    const observed = observedOf(managed(app));
    const plan = planApply({ networks: [], containers: [app] }, observed);
    expect(plan.missing).toEqual([]);
    expect(plan.changed).toEqual([]);
    expect(plan.orphaned).toEqual([]);
  });

  it('a container present with a different digest: changed, not missing', () => {
    const observed = observedOf(managed(app));
    const changedSpec: ContainerSpec = { ...app, image: 'app:2' };
    const plan = planApply({ networks: [], containers: [changedSpec] }, observed);
    expect(plan.changed).toEqual(['app']);
    expect(plan.missing).toEqual([]);
  });

  it('a managed container no longer desired: orphaned', () => {
    const observed = observedOf(managed(app));
    const plan = planApply({ networks: [], containers: [] }, observed);
    expect(plan.orphaned).toEqual(['app']);
  });

  it('an unmanaged container is never reported as orphaned, even if absent from the model', () => {
    // No MANAGED_LABEL, no specDigest: fiber-servo cannot prove it made this
    // one, so it must be left out of the comparison entirely — the same
    // "don't touch what we can't prove we made" rule the old planner applied.
    const observed = observedOf(container({ name: 'someone-elses-container' }));
    const plan = planApply({ networks: [], containers: [] }, observed);
    expect(plan.orphaned).toEqual([]);
  });

  it('a container present with the same digest but exited: restarting, neither missing nor changed', () => {
    // A digest comparison alone cannot see this: the spec is unchanged, so
    // `changedServices` says no, and it already exists, so it is not
    // `missing` either. Only checking observed phase directly reveals it.
    const observed = observedOf(managed(app, { phase: 'exited' }));
    const plan = planApply({ networks: [], containers: [app] }, observed);
    expect(plan.restarting).toEqual(['app']);
    expect(plan.missing).toEqual([]);
    expect(plan.changed).toEqual([]);
  });

  it('an unmanaged container with the same name as something now desired is not "changed"', () => {
    const observed = observedOf(container({ name: 'app' })); // no MANAGED_LABEL, no digest
    const plan = planApply({ networks: [], containers: [app] }, observed);
    expect(plan.changed).toEqual([]);
    // It reads as "missing" instead — fiber-servo simply doesn't know about
    // it, which is exactly the create-or-leave-alone question `Runtime.apply`
    // itself resolves (a real adapter would see it already exists and, per
    // its own idempotence contract, only touch it if the digest actually
    // differs — moot here since this test is about the *planner's* report).
    expect(plan.missing).toEqual(['app']);
  });

  it('model carries the desired networks and containers, same as toComposeApplication would build directly', () => {
    const plan = planApply({ networks: [{ name: 'backend' }], containers: [app] }, EMPTY, 'myproj');
    const direct = toComposeApplication([app], [{ name: 'backend' }], 'myproj');
    expect(plan.model).toEqual(direct);
  });
});

describe('formatPlan', () => {
  it('reports nothing to do for an empty plan', () => {
    const plan = planApply({ networks: [], containers: [] }, EMPTY);
    expect(formatPlan(plan)).toContain('nothing to do');
  });

  it('renders a create/replace/remove line per pending change', () => {
    const other: ContainerSpec = { name: 'other', image: 'other:1' };
    // `app` is observed with a stale digest (will read as changed), `other`
    // is observed and managed but no longer desired at all (orphaned), and
    // `db` is desired but never observed (missing).
    const observed = observedOf(managed(app), managed(other));
    const db: ContainerSpec = { name: 'db', image: 'postgres:16' };
    const plan = planApply({ networks: [], containers: [{ ...app, image: 'app:2' }, db] }, observed);
    const text = formatPlan(plan);
    expect(text).toContain('replace app');
    expect(text).toContain('remove other');
    expect(text).toContain('create db image=postgres:16');
  });
});
