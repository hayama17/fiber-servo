import { describe, expect, it } from 'vitest';
import {
  GENERATION_LABEL,
  OWNER_LABEL,
  expandDeployment,
  expandReplicaSet,
  runControllers,
  serviceEndpoints,
  serviceProxyPod,
} from '../src/controllers.js';
import { digest, type DeploymentSpec, type DesiredState, type ReplicaSetSpec } from '../src/resources.js';
import type { ObservedPod, ObservedState } from '../src/runtime/types.js';

// ---- small builders, matching the style of test/observed.test.ts ----------

function pod(overrides: Partial<ObservedPod> = {}): ObservedPod {
  return {
    name: 'api-0',
    phase: 'pending',
    labels: {},
    containers: [],
    at: 1,
    ...overrides,
  };
}

/** An observed Pod owned by a ReplicaSet/Deployment generation, as a real controller would stamp it. */
function ownedPod(
  name: string,
  owner: string,
  generation: string,
  overrides: Partial<ObservedPod> = {},
): ObservedPod {
  return pod({
    name,
    labels: { [OWNER_LABEL]: owner, [GENERATION_LABEL]: generation },
    containers: [{ name: 'app', phase: 'running' }],
    ...overrides,
  });
}

function observedOf(...pods: ObservedPod[]): ObservedState {
  return { pods: new Map(pods.map((p) => [p.name, p])), networks: new Map(), revision: 0 };
}

const EMPTY: ObservedState = { pods: new Map(), networks: new Map(), revision: 0 };

const template = { containers: [{ name: 'app', image: 'api:v1' }] };

// ---- expandReplicaSet -------------------------------------------------------

describe('expandReplicaSet', () => {
  it('the PLAN headline case: desired 3, observed only 2 alive, still yields 3 desired Pods', () => {
    const spec: ReplicaSetSpec = { name: 'web', replicas: 3, template };
    // Only two of the three Pods this ReplicaSet should own are observed at
    // all (the third is missing/dead) — desired state must not react to that.
    const observed = observedOf(
      ownedPod('web-0', 'web', digest(template)),
      ownedPod('web-1', 'web', digest(template)),
    );
    const pods = expandReplicaSet(spec, observed);
    expect(pods.map((p) => p.name)).toEqual(['web-0', 'web-1', 'web-2']);
    // The JSX/desired input is unchanged between the "3 observed" and
    // "2 observed" worlds: expandReplicaSet ignores `observed` entirely.
    expect(expandReplicaSet(spec, EMPTY)).toEqual(pods);
  });

  it('scaling 3 -> 5 keeps names 0..2 and only adds 3 and 4', () => {
    const spec3: ReplicaSetSpec = { name: 'web', replicas: 3, template };
    const spec5: ReplicaSetSpec = { name: 'web', replicas: 5, template };
    const at3 = expandReplicaSet(spec3, EMPTY).map((p) => p.name);
    const at5 = expandReplicaSet(spec5, EMPTY).map((p) => p.name);
    expect(at3).toEqual(['web-0', 'web-1', 'web-2']);
    expect(at5).toEqual(['web-0', 'web-1', 'web-2', 'web-3', 'web-4']);
  });

  it('stamps OWNER_LABEL and GENERATION_LABEL alongside the template labels', () => {
    const spec: ReplicaSetSpec = {
      name: 'web',
      replicas: 1,
      template: { ...template, labels: { app: 'web' } },
    };
    const [p] = expandReplicaSet(spec, EMPTY);
    expect(p!.labels).toEqual({
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
  const deploymentTemplate = { containers: [{ name: 'app', image: 'api:v2' }] };
  const newGen = digest(deploymentTemplate);
  const oldGen = 'aaaaaaaa'; // stand-in for a previous template's digest

  function threeOldPods(readyOverrides: Partial<ObservedPod> = {}): ObservedPod[] {
    return [
      ownedPod('web-aaaaaaaa-0', 'web', oldGen, { at: 1, ...readyOverrides }),
      ownedPod('web-aaaaaaaa-1', 'web', oldGen, { at: 2, ...readyOverrides }),
      ownedPod('web-aaaaaaaa-2', 'web', oldGen, { at: 3, ...readyOverrides }),
    ];
  }

  it('no new Pods ready yet: surges by maxSurge, old generation holds all its Pods', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };
    const observed = observedOf(...threeOldPods());
    const result = expandDeployment(spec, observed);
    // new-generation-first
    expect(result[0]).toMatchObject({ name: `web-${newGen}`, replicas: 1 }); // min(3, 0+1)
    expect(result[1]).toMatchObject({ name: `web-${oldGen}`, replicas: 3 }); // max(0, 3-0-0), capped at 3 existing
  });

  it('some new Pods ready: replicas split proportionally between generations', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };
    const observed = observedOf(
      ownedPod('web-' + newGen + '-0', 'web', newGen, { phase: 'running' }),
      ownedPod('web-' + newGen + '-1', 'web', newGen, { phase: 'pending' }), // not ready yet
      ...threeOldPods(),
    );
    const result = expandDeployment(spec, observed);
    expect(result[0]).toMatchObject({ name: `web-${newGen}`, replicas: 2 }); // min(3, 1+1)
    expect(result[1]).toMatchObject({ name: `web-${oldGen}`, replicas: 2 }); // max(0, 3-1-0)
  });

  it('all new Pods ready: old generation is driven to zero and therefore disappears from the running set', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };
    const observed = observedOf(
      ownedPod('web-' + newGen + '-0', 'web', newGen, { phase: 'running' }),
      ownedPod('web-' + newGen + '-1', 'web', newGen, { phase: 'running' }),
      ownedPod('web-' + newGen + '-2', 'web', newGen, { phase: 'running' }),
      ...threeOldPods(),
    );
    const result = expandDeployment(spec, observed);
    expect(result[0]).toMatchObject({ name: `web-${newGen}`, replicas: 3 }); // min(3, 3+1)
    // The old generation is still *returned*, but at 0 — that 0 is the
    // removal instruction, not an omission.
    expect(result[1]).toMatchObject({ name: `web-${oldGen}`, replicas: 0 });
    expect(result).toHaveLength(2);
  });

  it('a fresh Deployment with no observed Pods yet produces only the new generation', () => {
    // Even brand new, `newReplicas = min(replicas, newReady + maxSurge)`
    // applies literally: with no Pods observed yet and the default
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

  it('feeding a generated ReplicaSet through expandReplicaSet yields deterministic Pod names', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };
    const observed = observedOf(...threeOldPods());
    const [newRS] = expandDeployment(spec, observed);
    const pods = expandReplicaSet(newRS!, observed);
    expect(pods.map((p) => p.name)).toEqual([`web-${newGen}-0`]);
  });
});

// ---- serviceEndpoints / serviceProxyPod --------------------------------------

describe('serviceEndpoints', () => {
  it('filters by selector and by running phase, and sorts by Pod name', () => {
    const observed = observedOf(
      pod({ name: 'web-1', phase: 'running', labels: { app: 'web' }, ip: '10.0.0.2' }),
      pod({ name: 'web-0', phase: 'running', labels: { app: 'web' }, ip: '10.0.0.1' }),
      pod({ name: 'web-2', phase: 'pending', labels: { app: 'web' }, ip: '10.0.0.3' }), // not running: excluded
      pod({ name: 'other-0', phase: 'running', labels: { app: 'other' }, ip: '10.0.0.9' }), // selector mismatch
    );
    const endpoints = serviceEndpoints({ name: 'web', selector: { app: 'web' }, port: 80 }, observed);
    expect(endpoints).toEqual([
      { pod: 'web-0', address: '10.0.0.1', port: 80 },
      { pod: 'web-1', address: '10.0.0.2', port: 80 },
    ]);
  });

  it('falls back to the Pod name as the address when no IP has been observed', () => {
    const observed = observedOf(pod({ name: 'web-0', phase: 'running', labels: { app: 'web' } }));
    const endpoints = serviceEndpoints({ name: 'web', selector: { app: 'web' }, port: 80 }, observed);
    expect(endpoints).toEqual([{ pod: 'web-0', address: 'web-0', port: 80 }]);
  });

  it('uses targetPort, defaulting to port', () => {
    const observed = observedOf(pod({ name: 'web-0', phase: 'running', labels: { app: 'web' } }));
    const endpoints = serviceEndpoints(
      { name: 'web', selector: { app: 'web' }, port: 80, targetPort: 8080 },
      observed,
    );
    expect(endpoints[0]!.port).toBe(8080);
  });

  it('sorting is stable across calls with the same backend set', () => {
    const observed = observedOf(
      pod({ name: 'b', phase: 'running', labels: { app: 'web' } }),
      pod({ name: 'a', phase: 'running', labels: { app: 'web' } }),
    );
    const spec = { name: 'web', selector: { app: 'web' }, port: 80 };
    expect(serviceEndpoints(spec, observed)).toEqual(serviceEndpoints(spec, observed));
  });
});

describe('serviceProxyPod', () => {
  const spec = { name: 'web-svc', selector: { app: 'web' }, port: 80, targetPort: 8080 };

  it('returns undefined with no endpoints — a proxy with nothing behind it is worse than none', () => {
    expect(serviceProxyPod(spec, [])).toBeUndefined();
  });

  it('builds a caddy reverse-proxy command with one --to per endpoint', () => {
    const endpoints = [
      { pod: 'web-0', address: '10.0.0.1', port: 8080 },
      { pod: 'web-1', address: '10.0.0.2', port: 8080 },
    ];
    const proxyPod = serviceProxyPod(spec, endpoints);
    expect(proxyPod).toBeDefined();
    expect(proxyPod!.name).toBe('web-svc');
    expect(proxyPod!.containers).toHaveLength(1);
    expect(proxyPod!.containers[0]).toMatchObject({
      image: 'docker.io/library/caddy:2-alpine',
      command: ['caddy', 'reverse-proxy', '--from', ':80', '--to', '10.0.0.1:8080', '--to', '10.0.0.2:8080'],
    });
  });

  it('publishes a host port only when the Service asks for one', () => {
    const endpoints = [{ pod: 'web-0', address: '10.0.0.1', port: 8080 }];
    expect(serviceProxyPod(spec, endpoints)!.publish).toBeUndefined();
    const published = serviceProxyPod({ ...spec, publish: 8000 }, endpoints);
    expect(published!.publish).toEqual([{ host: 8000, target: 80 }]);
  });
});

// ---- runControllers -----------------------------------------------------------

describe('runControllers', () => {
  it('passes networks and bare Pods through unchanged, in tree order', () => {
    const desired: DesiredState = {
      resources: [
        { kind: 'network', name: 'backend', spec: { name: 'backend' } },
        { kind: 'pod', name: 'standalone', spec: { name: 'standalone', containers: [] } },
      ],
    };
    const result = runControllers(desired, EMPTY);
    expect(result.networks).toEqual([{ name: 'backend' }]);
    expect(result.pods.map((p) => p.name)).toEqual(['standalone']);
  });

  it('expands a replicaset resource into Pods', () => {
    const desired: DesiredState = {
      resources: [{ kind: 'replicaset', name: 'web', spec: { name: 'web', replicas: 2, template } }],
    };
    const result = runControllers(desired, EMPTY);
    expect(result.pods.map((p) => p.name)).toEqual(['web-0', 'web-1']);
    expect(result.pods[0]!.labels?.[OWNER_LABEL]).toBe('web');
  });

  it('expands a deployment resource, relabeling generated Pods with the Deployment as owner', () => {
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
    expect(result.pods).toHaveLength(2);
    for (const p of result.pods) {
      expect(p.labels?.[OWNER_LABEL]).toBe('web'); // the Deployment's name, not the generated ReplicaSet's
      expect(p.labels?.[GENERATION_LABEL]).toBe(digest(template));
    }
  });

  it('turns a service resource into its proxy Pod, once endpoints exist', () => {
    const desired: DesiredState = {
      resources: [
        { kind: 'service', name: 'web-svc', spec: { name: 'web-svc', selector: { app: 'web' }, port: 80 } },
      ],
    };
    const observed = observedOf(pod({ name: 'web-0', phase: 'running', labels: { app: 'web' } }));
    const result = runControllers(desired, observed);
    expect(result.pods.map((p) => p.name)).toEqual(['web-svc']);
  });

  it('a service with no matching endpoints contributes no Pod at all', () => {
    const desired: DesiredState = {
      resources: [
        { kind: 'service', name: 'web-svc', spec: { name: 'web-svc', selector: { app: 'web' }, port: 80 } },
      ],
    };
    expect(runControllers(desired, EMPTY).pods).toEqual([]);
  });

  it('throws a clear error when two resources produce a Pod with the same name', () => {
    const desired: DesiredState = {
      resources: [
        { kind: 'pod', name: 'web-0', spec: { name: 'web-0', containers: [] } },
        { kind: 'replicaset', name: 'web', spec: { name: 'web', replicas: 1, template } },
      ],
    };
    expect(() => runControllers(desired, EMPTY)).toThrow(/fiber-servo:.*"web-0"/);
  });
});
