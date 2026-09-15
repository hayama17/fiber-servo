import { describe, expect, it } from 'vitest';
import { MANAGED_LABEL, SPEC_LABEL, toComposeApplication } from '../src/compose.js';
import { formatPlan, planApply, planIsEmpty } from '../src/planner.js';
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

// Networks are the one part of the model with no observation behind them:
// Compose owns their lifecycle, so `ObservedState` carries none and there is
// nothing to diff a declaration against. They are compared against the last
// applied model instead -- and without that comparison, a network-only edit
// changes no service, produces an empty plan, and is never applied at all.
describe('planApply: networks', () => {
  const app = (networks: { name: string; subnet?: string }[]) =>
    toComposeApplication([], networks, 'fiber-servo');

  it('reports a network the previous model did not declare', () => {
    const plan = planApply(
      { networks: [{ name: 'backend' }], containers: [] },
      EMPTY,
      'fiber-servo',
      app([]),
    );
    expect(plan.networks).toEqual({ added: ['backend'], changed: [], removed: [] });
  });

  it('reports a network the model no longer declares', () => {
    const previous = app([{ name: 'backend' }]);
    const plan = planApply({ networks: [], containers: [] }, EMPTY, 'fiber-servo', previous);
    expect(plan.networks).toEqual({ added: [], changed: [], removed: ['backend'] });
  });

  it('reports a changed subnet', () => {
    const previous = app([{ name: 'backend', subnet: '10.1.0.0/24' }]);
    const plan = planApply(
      { networks: [{ name: 'backend', subnet: '10.2.0.0/24' }], containers: [] },
      EMPTY,
      'fiber-servo',
      previous,
    );
    expect(plan.networks).toEqual({ added: [], changed: ['backend'], removed: [] });
  });

  it('reports nothing when the networks are unchanged', () => {
    const previous = app([{ name: 'backend', subnet: '10.1.0.0/24' }]);
    const plan = planApply(
      { networks: [{ name: 'backend', subnet: '10.1.0.0/24' }], containers: [] },
      EMPTY,
      'fiber-servo',
      previous,
    );
    expect(plan.networks).toEqual({ added: [], changed: [], removed: [] });
    expect(planIsEmpty(plan)).toBe(true);
  });

  // The point of all of the above: a plan that only touches networks must
  // still be applied.
  it('is not an empty plan when only a network changed', () => {
    const previous = app([{ name: 'backend' }]);
    const plan = planApply(
      { networks: [{ name: 'backend', subnet: '10.9.0.0/24' }], containers: [] },
      EMPTY,
      'fiber-servo',
      previous,
    );
    expect(plan.missing).toEqual([]);
    expect(plan.changed).toEqual([]);
    expect(planIsEmpty(plan)).toBe(false);
    expect(formatPlan(plan)).toContain('replace network backend');
  });

  // The boundary of the guarantee, pinned so the docs and the code cannot
  // drift apart: this compares declarations, not reality. A network someone
  // removes by hand while fiber-servo is running changes no declaration, so
  // nothing here notices and nothing brings it back. Containers are
  // level-triggered against a real observation; networks are not.
  it('does not notice a network that disappeared outside fiber-servo', () => {
    const previous = app([{ name: 'backend' }]);
    // Observed state says nothing about networks at all -- there is no field
    // for it -- so there is no way to express "the network is gone", which is
    // precisely the gap.
    const plan = planApply(
      { networks: [{ name: 'backend' }], containers: [] },
      EMPTY,
      'fiber-servo',
      previous,
    );
    expect(plan.networks).toEqual({ added: [], changed: [], removed: [] });
    expect(planIsEmpty(plan)).toBe(true);
  });

  // A fresh process has no previous model. Treating everything as new is the
  // safe direction: it costs one idempotent `compose up`, where the opposite
  // would leave a declared network uncreated until something else changed.
  it('treats every declared network as new when there is no previous model', () => {
    const plan = planApply({ networks: [{ name: 'backend' }], containers: [] }, EMPTY);
    expect(plan.networks.added).toEqual(['backend']);
    expect(planIsEmpty(plan)).toBe(false);
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
