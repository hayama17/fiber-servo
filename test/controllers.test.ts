import { describe, expect, it } from 'vitest';
import {
  GENERATION_LABEL,
  OWNER_LABEL,
  expandDeployment,
  expandReplicaSet,
  runControllers,
  serviceEndpoints,
  serviceProxyContainer,
} from '../src/controllers.js';
import { digest, type DeploymentSpec, type DesiredState, type ReplicaSetSpec } from '../src/resources.js';
import type { ObservedContainer, ObservedState } from '../src/runtime/types.js';

// ---- small builders, matching the style of test/observed.test.ts ----------

function container(overrides: Partial<ObservedContainer> = {}): ObservedContainer {
  return {
    name: 'api-0',
    phase: 'waiting',
    networks: [],
    labels: {},
    at: 1,
    ...overrides,
  };
}

/** An observed container owned by a ReplicaSet/Deployment generation, as a real controller would stamp it. */
function ownedContainer(
  name: string,
  owner: string,
  generation: string,
  overrides: Partial<ObservedContainer> = {},
): ObservedContainer {
  return container({
    name,
    phase: 'running',
    labels: { [OWNER_LABEL]: owner, [GENERATION_LABEL]: generation },
    image: 'api:v1',
    ...overrides,
  });
}

function observedOf(...containers: ObservedContainer[]): ObservedState {
  return { containers: new Map(containers.map((c) => [c.name, c])), revision: 0 };
}

const EMPTY: ObservedState = { containers: new Map(), revision: 0 };

const template = { image: 'api:v1' };

// ---- expandReplicaSet -------------------------------------------------------

describe('expandReplicaSet', () => {
  it('the PLAN headline case: desired 3, observed only 2 alive, still yields 3 desired Containers', () => {
    const spec: ReplicaSetSpec = { name: 'web', replicas: 3, template };
    // Only two of the three Containers this ReplicaSet should own are
    // observed at all (the third is missing/dead) — desired state must not
    // react to that.
    const observed = observedOf(
      ownedContainer('web-0', 'web', digest(template)),
      ownedContainer('web-1', 'web', digest(template)),
    );
    const containers = expandReplicaSet(spec, observed);
    expect(containers.map((c) => c.name)).toEqual(['web-0', 'web-1', 'web-2']);
    // The JSX/desired input is unchanged between the "3 observed" and
    // "2 observed" worlds: expandReplicaSet ignores `observed` entirely.
    expect(expandReplicaSet(spec, EMPTY)).toEqual(containers);
  });

  it('scaling 3 -> 5 keeps names 0..2 and only adds 3 and 4', () => {
    const spec3: ReplicaSetSpec = { name: 'web', replicas: 3, template };
    const spec5: ReplicaSetSpec = { name: 'web', replicas: 5, template };
    const at3 = expandReplicaSet(spec3, EMPTY).map((c) => c.name);
    const at5 = expandReplicaSet(spec5, EMPTY).map((c) => c.name);
    expect(at3).toEqual(['web-0', 'web-1', 'web-2']);
    expect(at5).toEqual(['web-0', 'web-1', 'web-2', 'web-3', 'web-4']);
  });

  it('stamps OWNER_LABEL and GENERATION_LABEL alongside the template labels', () => {
    const spec: ReplicaSetSpec = {
      name: 'web',
      replicas: 1,
      template: { ...template, labels: { app: 'web' } },
    };
    const [c] = expandReplicaSet(spec, EMPTY);
    expect(c!.labels).toEqual({
      app: 'web',
      [OWNER_LABEL]: 'web',
      [GENERATION_LABEL]: digest(spec.template),
    });
  });

  it('rejects a negative or non-integer replica count', () => {
    expect(() => expandReplicaSet({ name: 'web', replicas: -1, template }, EMPTY)).toThrow(/fiber-servo:/);
    expect(() => expandReplicaSet({ name: 'web', replicas: 1.5, template }, EMPTY)).toThrow(/fiber-servo:/);
  });

  it('throws when a template label collides with a reserved key', () => {
    const spec: ReplicaSetSpec = {
      name: 'web',
      replicas: 1,
      template: { ...template, labels: { [OWNER_LABEL]: 'someone-else' } },
    };
    expect(() => expandReplicaSet(spec, EMPTY)).toThrow(/fiber-servo:/);
  });
});

// ---- expandDeployment --------------------------------------------------------

describe('expandDeployment', () => {
  const deploymentTemplate = { image: 'api:v2' };
  const newGen = digest(deploymentTemplate);
  const oldGen = 'aaaaaaaa'; // stand-in for a previous template's digest

  function threeOldContainers(readyOverrides: Partial<ObservedContainer> = {}): ObservedContainer[] {
    return [
      ownedContainer('web-aaaaaaaa-0', 'web', oldGen, { at: 1, ...readyOverrides }),
      ownedContainer('web-aaaaaaaa-1', 'web', oldGen, { at: 2, ...readyOverrides }),
      ownedContainer('web-aaaaaaaa-2', 'web', oldGen, { at: 3, ...readyOverrides }),
    ];
  }

  it('no new containers ready yet: surges by maxSurge, old generation holds all its containers', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };
    const observed = observedOf(...threeOldContainers());
    const result = expandDeployment(spec, observed);
    // new-generation-first
    expect(result[0]).toMatchObject({ name: `web-${newGen}`, replicas: 1 }); // min(3, 0+1)
    expect(result[1]).toMatchObject({ name: `web-${oldGen}`, replicas: 3 }); // max(0, 3-0-0), capped at 3 existing
  });

  it('some new containers ready: replicas split proportionally between generations', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };
    const observed = observedOf(
      ownedContainer('web-' + newGen + '-0', 'web', newGen, { phase: 'running' }),
      ownedContainer('web-' + newGen + '-1', 'web', newGen, { phase: 'waiting' }), // not ready yet
      ...threeOldContainers(),
    );
    const result = expandDeployment(spec, observed);
    expect(result[0]).toMatchObject({ name: `web-${newGen}`, replicas: 2 }); // min(3, 1+1)
    expect(result[1]).toMatchObject({ name: `web-${oldGen}`, replicas: 2 }); // max(0, 3-1-0)
  });

  it('all new containers ready: old generation is driven to zero and therefore disappears from the running set', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };
    const observed = observedOf(
      ownedContainer('web-' + newGen + '-0', 'web', newGen, { phase: 'running' }),
      ownedContainer('web-' + newGen + '-1', 'web', newGen, { phase: 'running' }),
      ownedContainer('web-' + newGen + '-2', 'web', newGen, { phase: 'running' }),
      ...threeOldContainers(),
    );
    const result = expandDeployment(spec, observed);
    expect(result[0]).toMatchObject({ name: `web-${newGen}`, replicas: 3 }); // min(3, 3+1)
    // The old generation is still *returned*, but at 0 — that 0 is the
    // removal instruction, not an omission.
    expect(result[1]).toMatchObject({ name: `web-${oldGen}`, replicas: 0 });
    expect(result).toHaveLength(2);
  });

  it('a fresh Deployment with no observed containers yet produces only the new generation', () => {
    // Even brand new, `newReplicas = min(replicas, newReady + maxSurge)`
    // applies literally: with no containers observed yet and the default
    // maxSurge of 1, the very first tick asks for only 1 — the same surge
    // cap that limits a rollout also paces a from-scratch rollout, one
    // generation and nothing to hold it back from ramping every subsequent
    // tick until observed reality (newReady) catches up.
    const spec: DeploymentSpec = { name: 'web', replicas: 2, template: deploymentTemplate };
    const result = expandDeployment(spec, EMPTY);
    expect(result).toEqual([{ name: `web-${newGen}`, replicas: 1, template: deploymentTemplate }]);
  });

  it('a fresh Deployment ramps to its full replica count once maxSurge allows it', () => {
    const spec: DeploymentSpec = {
      name: 'web',
      replicas: 2,
      template: deploymentTemplate,
      strategy: { maxSurge: 2 },
    };
    expect(expandDeployment(spec, EMPTY)).toEqual([
      { name: `web-${newGen}`, replicas: 2, template: deploymentTemplate },
    ]);
  });

  it('feeding a generated ReplicaSet through expandReplicaSet yields deterministic container names', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };
    const observed = observedOf(...threeOldContainers());
    const [newRS] = expandDeployment(spec, observed);
    const containers = expandReplicaSet(newRS!, observed);
    expect(containers.map((c) => c.name)).toEqual([`web-${newGen}-0`]);
  });
});

// ---- serviceEndpoints / serviceProxyContainer --------------------------------------

describe('serviceEndpoints', () => {
  it('filters by selector and by running phase, and sorts by container name', () => {
    const observed = observedOf(
      container({ name: 'web-1', phase: 'running', labels: { app: 'web' } }),
      container({ name: 'web-0', phase: 'running', labels: { app: 'web' } }),
      container({ name: 'web-2', phase: 'waiting', labels: { app: 'web' } }), // not running: excluded
      container({ name: 'other-0', phase: 'running', labels: { app: 'other' } }), // selector mismatch
    );
    const endpoints = serviceEndpoints({ name: 'web', selector: { app: 'web' }, port: 80 }, observed);
    expect(endpoints).toEqual([
      { container: 'web-0', address: 'web-0', port: 80 },
      { container: 'web-1', address: 'web-1', port: 80 },
    ]);
  });

  it('always addresses by container name — there is no IP to prefer', () => {
    const observed = observedOf(container({ name: 'web-0', phase: 'running', labels: { app: 'web' } }));
    const endpoints = serviceEndpoints({ name: 'web', selector: { app: 'web' }, port: 80 }, observed);
    expect(endpoints).toEqual([{ container: 'web-0', address: 'web-0', port: 80 }]);
  });

  it('uses targetPort, defaulting to port', () => {
    const observed = observedOf(container({ name: 'web-0', phase: 'running', labels: { app: 'web' } }));
    const endpoints = serviceEndpoints(
      { name: 'web', selector: { app: 'web' }, port: 80, targetPort: 8080 },
      observed,
    );
    expect(endpoints[0]!.port).toBe(8080);
  });

  it('sorting is stable across calls with the same backend set', () => {
    const observed = observedOf(
      container({ name: 'b', phase: 'running', labels: { app: 'web' } }),
      container({ name: 'a', phase: 'running', labels: { app: 'web' } }),
    );
    const spec = { name: 'web', selector: { app: 'web' }, port: 80 };
    expect(serviceEndpoints(spec, observed)).toEqual(serviceEndpoints(spec, observed));
  });
});

describe('serviceProxyContainer', () => {
  const spec = { name: 'web-svc', selector: { app: 'web' }, port: 80, targetPort: 8080 };

  it('returns undefined with no endpoints — a proxy with nothing behind it is worse than none', () => {
    expect(serviceProxyContainer(spec, [])).toBeUndefined();
  });

  it('builds a caddy reverse-proxy command with one --to per endpoint, addressed by name', () => {
    const endpoints = [
      { container: 'web-0', address: 'web-0', port: 8080 },
      { container: 'web-1', address: 'web-1', port: 8080 },
    ];
    const proxy = serviceProxyContainer(spec, endpoints);
    expect(proxy).toBeDefined();
    expect(proxy!.name).toBe('web-svc');
    expect(proxy!.image).toBe('docker.io/library/caddy:2-alpine');
    expect(proxy!.command).toEqual([
      'caddy',
      'reverse-proxy',
      '--from',
      ':80',
      '--to',
      'web-0:8080',
      '--to',
      'web-1:8080',
    ]);
  });

  it('publishes a host port only when the Service asks for one', () => {
    const endpoints = [{ container: 'web-0', address: 'web-0', port: 8080 }];
    expect(serviceProxyContainer(spec, endpoints)!.publish).toBeUndefined();
    const published = serviceProxyContainer({ ...spec, publish: 8000 }, endpoints);
    expect(published!.publish).toEqual([{ host: 8000, target: 80 }]);
  });
});

// ---- runControllers -----------------------------------------------------------

describe('runControllers', () => {
  it('passes networks and bare containers through unchanged, in tree order', () => {
    const desired: DesiredState = {
      resources: [
        { kind: 'network', name: 'backend', spec: { name: 'backend' } },
        { kind: 'container', name: 'standalone', spec: { name: 'standalone', image: 'app:1' } },
      ],
    };
    const result = runControllers(desired, EMPTY);
    expect(result.networks).toEqual([{ name: 'backend' }]);
    expect(result.containers.map((c) => c.name)).toEqual(['standalone']);
  });

  it('expands a replicaset resource into containers', () => {
    const desired: DesiredState = {
      resources: [{ kind: 'replicaset', name: 'web', spec: { name: 'web', replicas: 2, template } }],
    };
    const result = runControllers(desired, EMPTY);
    expect(result.containers.map((c) => c.name)).toEqual(['web-0', 'web-1']);
    expect(result.containers[0]!.labels?.[OWNER_LABEL]).toBe('web');
  });

  it('expands a deployment resource, relabeling generated containers with the Deployment as owner', () => {
    const desired: DesiredState = {
      resources: [
        {
          kind: 'deployment',
          name: 'web',
          // maxSurge: 2 so both replicas land in this one tick — the point
          // of this test is the relabeling, not rollout pacing (covered by
          // the expandDeployment tests above).
          spec: { name: 'web', replicas: 2, template, strategy: { maxSurge: 2 } },
        },
      ],
    };
    const result = runControllers(desired, EMPTY);
    expect(result.containers).toHaveLength(2);
    for (const c of result.containers) {
      expect(c.labels?.[OWNER_LABEL]).toBe('web'); // the Deployment's name, not the generated ReplicaSet's
      expect(c.labels?.[GENERATION_LABEL]).toBe(digest(template));
    }
  });

  it('turns a service resource into its proxy container, once endpoints exist', () => {
    const desired: DesiredState = {
      resources: [
        { kind: 'service', name: 'web-svc', spec: { name: 'web-svc', selector: { app: 'web' }, port: 80 } },
      ],
    };
    const observed = observedOf(container({ name: 'web-0', phase: 'running', labels: { app: 'web' } }));
    const result = runControllers(desired, observed);
    expect(result.containers.map((c) => c.name)).toEqual(['web-svc']);
  });

  it('a service with no matching endpoints contributes no container at all', () => {
    const desired: DesiredState = {
      resources: [
        { kind: 'service', name: 'web-svc', spec: { name: 'web-svc', selector: { app: 'web' }, port: 80 } },
      ],
    };
    expect(runControllers(desired, EMPTY).containers).toEqual([]);
  });

  it('throws a clear error when two resources produce a container with the same name', () => {
    const desired: DesiredState = {
      resources: [
        { kind: 'container', name: 'web-0', spec: { name: 'web-0', image: 'app:1' } },
        { kind: 'replicaset', name: 'web', spec: { name: 'web', replicas: 1, template } },
      ],
    };
    expect(() => runControllers(desired, EMPTY)).toThrow(/fiber-servo:.*"web-0"/);
  });
});
