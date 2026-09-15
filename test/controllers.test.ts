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
import {
  digest,
  shortDigest,
  type ContainerTemplate,
  type DeploymentSpec,
  type DesiredState,
  type ReplicaSetSpec,
} from '../src/resources.js';
import { createMemoryGenerationStore, type Generations } from '../src/generations.js';
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

/**
 * An observed container owned by a Deployment generation, labelled the way a
 * real controller labels one.
 *
 * It takes the *template*, not a generation string, because that is what the
 * real thing has: `expandReplicaSet` derives the generation from the
 * template's digest. A fixture that made up a generation with no template
 * behind it would be describing a container fiber-servo cannot produce.
 */
function ownedContainer(
  name: string,
  owner: string,
  template: ContainerTemplate,
  overrides: Partial<ObservedContainer> = {},
): ObservedContainer {
  return container({
    name,
    phase: 'running',
    labels: {
      ...template.labels,
      [OWNER_LABEL]: owner,
      [GENERATION_LABEL]: digest(template),
    },
    image: template.image,
    ...overrides,
  });
}

/** The generation history a `serve()` pass would have accumulated for these templates. */
function generationsOf(...templates: ContainerTemplate[]): Generations {
  const store = createMemoryGenerationStore();
  for (const template of templates) store.remember(template);
  return store.all();
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
      ownedContainer('web-0', 'web', template),
      ownedContainer('web-1', 'web', template),
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

  it('stamps the three controller labels alongside the template labels', () => {
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

  // containerd refuses a label whose key and value together exceed 4096
  // bytes, and an environment of a few kilobytes is an ordinary thing to
  // want. Carrying the template on the container made such a spec impossible
  // to create at all; see `generations.ts`.
  it("keeps every label well clear of containerd's 4096-byte limit, however big the template", () => {
    const huge: ContainerTemplate = {
      image: 'api:v1',
      env: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`VAR_${String(i)}`, 'x'.repeat(64)])),
      labels: { app: 'web' },
    };
    const [c] = expandReplicaSet({ name: 'web', replicas: 1, template: huge }, EMPTY);

    for (const [key, value] of Object.entries(c!.labels ?? {})) {
      expect(Buffer.byteLength(key) + Buffer.byteLength(value), `label ${key}`).toBeLessThan(4096);
    }
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
  /** The generation's identity, as `GENERATION_LABEL` carries it. */
  const newGen = digest(deploymentTemplate);
  /** What it is *called* — the suffix a ReplicaSet and its containers get. */
  const newName = shortDigest(deploymentTemplate);
  // A real previous template, not a made-up digest: the generation IS
  // `digest(template)`, and an old generation is only drainable because its
  // containers still carry the template that named it.
  const oldTemplate: ContainerTemplate = {
    image: 'api:v1',
    command: ['./server', '--legacy'],
    env: { MODE: 'prod' },
    network: 'backend',
    resources: { cpu: 0.5, memory: '512m' },
    readiness: { exec: ['/health'] },
  };
  const oldGen = digest(oldTemplate);
  const oldName = shortDigest(oldTemplate);
  /** What `serve()` would have accumulated by the time the template was edited. */
  const history = generationsOf(oldTemplate, deploymentTemplate);

  /**
   * The three containers generation `oldGen` actually produced -- built by
   * running the real `expandReplicaSet` and recording what a runtime would
   * observe back, rather than by hand, so `specDigest` is the digest of a
   * spec this codebase can genuinely produce.
   */
  function threeOldContainers(readyOverrides: Partial<ObservedContainer> = {}): ObservedContainer[] {
    const produced = expandReplicaSet({ name: `web-${oldName}`, replicas: 3, template: oldTemplate }, EMPTY);
    return produced.map((c, i) =>
      container({
        name: c.name,
        phase: 'running',
        image: c.image,
        networks: c.network ? [c.network] : [],
        labels: { ...c.labels, [OWNER_LABEL]: 'web', [GENERATION_LABEL]: oldGen },
        specDigest: digest({
          ...c,
          labels: { ...c.labels, [OWNER_LABEL]: 'web', [GENERATION_LABEL]: oldGen },
        }),
        at: i + 1,
        ...readyOverrides,
      }),
    );
  }

  it('no new containers ready yet: surges by maxSurge, old generation holds all its containers', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };
    const observed = observedOf(...threeOldContainers());
    const result = expandDeployment(spec, observed, history);
    // new-generation-first
    expect(result[0]).toMatchObject({ name: `web-${newName}`, replicas: 1 }); // min(3, 0+1)
    expect(result[1]).toMatchObject({ name: `web-${oldName}`, replicas: 3 }); // max(0, 3-0-0), capped at 3 existing
  });

  it('some new containers ready: replicas split proportionally between generations', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };
    const observed = observedOf(
      ownedContainer(`web-${newName}-0`, 'web', deploymentTemplate, { phase: 'running' }),
      ownedContainer(`web-${newName}-1`, 'web', deploymentTemplate, { phase: 'waiting' }), // not ready yet
      ...threeOldContainers(),
    );
    const result = expandDeployment(spec, observed, history);
    expect(result[0]).toMatchObject({ name: `web-${newName}`, replicas: 2 }); // min(3, 1+1)
    expect(result[1]).toMatchObject({ name: `web-${oldName}`, replicas: 2 }); // max(0, 3-1-0)
  });

  it('all new containers ready: old generation is driven to zero and therefore disappears from the running set', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };
    const observed = observedOf(
      ownedContainer(`web-${newName}-0`, 'web', deploymentTemplate, { phase: 'running' }),
      ownedContainer(`web-${newName}-1`, 'web', deploymentTemplate, { phase: 'running' }),
      ownedContainer(`web-${newName}-2`, 'web', deploymentTemplate, { phase: 'running' }),
      ...threeOldContainers(),
    );
    const result = expandDeployment(spec, observed, history);
    expect(result[0]).toMatchObject({ name: `web-${newName}`, replicas: 3 }); // min(3, 3+1)
    // The old generation is still *returned*, but at 0 — that 0 is the
    // removal instruction, not an omission.
    expect(result[1]).toMatchObject({ name: `web-${oldName}`, replicas: 0 });
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
    expect(result).toEqual([{ name: `web-${newName}`, replicas: 1, template: deploymentTemplate }]);
  });

  it('a fresh Deployment ramps to its full replica count once maxSurge allows it', () => {
    const spec: DeploymentSpec = {
      name: 'web',
      replicas: 2,
      template: deploymentTemplate,
      strategy: { maxSurge: 2 },
    };
    expect(expandDeployment(spec, EMPTY)).toEqual([
      { name: `web-${newName}`, replicas: 2, template: deploymentTemplate },
    ]);
  });

  // A generation's identity and a generation's name are two different things.
  // The label is what anything comparing generations reads; the name is a
  // truncation for human eyes. Conflating them is how a readability decision
  // turns into a correctness one.
  describe('identity versus name', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };

    it('labels a replica with the full digest and names it with the short one', () => {
      const observed = observedOf(...threeOldContainers());
      const [newRS] = expandDeployment(spec, observed, history);
      const [c] = expandReplicaSet(newRS!, observed);

      expect(newRS!.name).toBe(`web-${shortDigest(deploymentTemplate)}`);
      expect(c!.labels?.[GENERATION_LABEL]).toBe(digest(deploymentTemplate));
      expect(c!.labels?.[GENERATION_LABEL]).not.toBe(shortDigest(deploymentTemplate));
    });

    it('buckets observed containers by the full identity, not by the name', () => {
      // Two containers that agree on the short form but not the full digest
      // are different generations, and nothing may merge them. Constructed
      // rather than found, because finding a real collision is the thing
      // SHA-256 makes impossible.
      const impostor = {
        ...threeOldContainers()[0]!,
        name: 'web-impostor-0',
        labels: {
          ...threeOldContainers()[0]!.labels,
          [GENERATION_LABEL]: `${oldGen.slice(0, 16)}${'f'.repeat(48)}`,
        },
      };
      const result = expandDeployment(spec, observedOf(...threeOldContainers(), impostor), history);

      // The impostor's generation is unknown to the store, so it is dropped —
      // and crucially it did not join the real old generation's bucket.
      const old = result.find((rs) => rs.name === `web-${oldName}`);
      expect(old?.replicas).toBe(3); // still three, not four
    });

    it('recovers an old generation by its full identity', () => {
      // A store keyed by the short form would answer this lookup; keyed by
      // the full identity it does not, because that is not what it is.
      const shortKeyed: Generations = new Map([[oldName, oldTemplate]]);
      const result = expandDeployment(spec, observedOf(...threeOldContainers()), shortKeyed);
      expect(result.map((rs) => rs.name)).toEqual([`web-${shortDigest(deploymentTemplate)}`]);
    });
  });

  // The whole point of TEMPLATE_LABEL. Before it, an old generation was
  // reconstructed from `image` + `labels` alone, so the moment a rollout
  // started every surviving old container had a desired spec thinner than
  // the one it was created from -- a different digest, so the planner
  // replaced them all, without their command, env, network, resources or
  // readiness probe.
  describe('draining an old generation', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };

    /**
     * What `runControllers` produces for this Deployment: the ReplicaSets it
     * expands, with the owner and generation labels corrected to the
     * Deployment's own name the way that function corrects them.
     */
    function desiredContainers(observed: ObservedState) {
      return expandDeployment(spec, observed, history).flatMap((rs) =>
        expandReplicaSet(rs, observed).map((c) => ({
          ...c,
          labels: {
            ...c.labels,
            [OWNER_LABEL]: 'web',
            [GENERATION_LABEL]: digest(rs.template),
          },
        })),
      );
    }

    function oldReplicaSet(): ReplicaSetSpec {
      const observed = observedOf(...threeOldContainers());
      const found = expandDeployment(spec, observed, history).find((rs) => rs.name === `web-${oldName}`);
      if (!found) throw new Error('the old generation was not returned at all');
      return found;
    }

    it('recovers the old template exactly, field for field', () => {
      expect(oldReplicaSet().template).toEqual(oldTemplate);
    });

    it.each([
      ['env', (t: ContainerTemplate) => t.env],
      ['command', (t: ContainerTemplate) => t.command],
      ['network', (t: ContainerTemplate) => t.network],
      ['resources', (t: ContainerTemplate) => t.resources],
      ['readiness', (t: ContainerTemplate) => t.readiness],
    ])('keeps %s, which the old reconstruction dropped', (_name, read) => {
      expect(read(oldReplicaSet().template)).toEqual(read(oldTemplate));
    });

    // The strongest statement of the fix: a container recreated mid-drain is
    // byte-identical to the one it replaces, so nothing downstream can tell
    // that it was ever gone.
    it('regenerates a container that died mid-rollout with an unchanged spec', () => {
      const alive = threeOldContainers();
      const [killed] = alive;
      const observed = observedOf(...alive.slice(1)); // `web-<oldGen>-0` has died
      const regenerated = desiredContainers(observed).find((c) => c.name === killed!.name);

      expect(regenerated).toBeDefined();
      expect(digest(regenerated)).toBe(killed!.specDigest);
    });

    // And the completion criterion: merely starting a rollout must not mark
    // a single old container as changed.
    it('replaces no old container just because a rollout started', () => {
      const observed = observedOf(...threeOldContainers());
      const desired = desiredContainers(observed);
      for (const [name, was] of observed.containers) {
        const now = desired.find((c) => c.name === name);
        expect(now, `${name} vanished from the desired set`).toBeDefined();
        expect(digest(now), `${name} would be replaced`).toBe(was.specDigest);
      }
    });

    // A generation whose template cannot be reproduced is not kept alive
    // under a spec this code invented; see `generations.ts`.
    it('drops a generation the store has never heard of rather than guessing at it', () => {
      const result = expandDeployment(
        spec,
        observedOf(...threeOldContainers()),
        generationsOf(deploymentTemplate),
      );
      expect(result.map((rs) => rs.name)).toEqual([`web-${newName}`]);
    });

    it('drops a generation the store has a mismatched template for', () => {
      // A store entry filed under an id that is not its own digest: a
      // hand-edited or corrupt file. It is not what it claims to be, so it
      // is not used.
      const wrong: Generations = new Map([[oldGen, { image: 'something-else:v9' }]]);
      const result = expandDeployment(spec, observedOf(...threeOldContainers()), wrong);
      expect(result.map((rs) => rs.name)).toEqual([`web-${newName}`]);
    });
  });

  // "the process started" and "it can serve traffic" are different facts, and
  // a rollout that conflates them defeats maxUnavailable exactly when it
  // matters: the old generation is drained during the window in which the
  // new one is up but cannot answer anything.
  describe('readiness-aware progress', () => {
    const probed: ContainerTemplate = { image: 'api:v2', readiness: { exec: ['/health'] } };
    const probedGen = shortDigest(probed);
    const spec: DeploymentSpec = {
      name: 'web',
      replicas: 3,
      template: probed,
      strategy: { maxUnavailable: 0 },
    };

    function newContainers(ready: boolean | undefined, count: number): ObservedContainer[] {
      return Array.from({ length: count }, (_, i) =>
        ownedContainer(`web-${probedGen}-${i}`, 'web', probed, { phase: 'running', ready }),
      );
    }

    it('does not shrink the old generation for a container that is running but not ready', () => {
      const observed = observedOf(...newContainers(false, 2), ...threeOldContainers());
      const result = expandDeployment(spec, observed, history);
      // newReady is 0, so the old generation keeps all three: 3 - 0 - 0.
      expect(result.find((rs) => rs.name === `web-${oldName}`)?.replicas).toBe(3);
    });

    it('resumes progress once those containers report ready', () => {
      const observed = observedOf(...newContainers(true, 2), ...threeOldContainers());
      const result = expandDeployment(spec, observed, history);
      expect(result.find((rs) => rs.name === `web-${probedGen}`)?.replicas).toBe(3); // min(3, 2+1)
      expect(result.find((rs) => rs.name === `web-${oldName}`)?.replicas).toBe(1); // 3 - 2 - 0
    });

    // The guarantee stated plainly: at no point does ready-new plus kept-old
    // fall below `replicas`.
    it('never lets availability dip below replicas while maxUnavailable is 0', () => {
      for (const [readyCount, unready] of [
        [0, 3],
        [1, 2],
        [2, 1],
        [3, 0],
      ]) {
        const observed = observedOf(
          ...newContainers(true, readyCount!),
          ...newContainers(false, unready!).map((c, i) => ({
            ...c,
            name: `web-${probedGen}-${readyCount! + i}`,
          })),
          ...threeOldContainers(),
        );
        const keptOld = expandDeployment(spec, observed, history).find((rs) => rs.name === `web-${oldName}`);
        expect(
          readyCount! + (keptOld?.replicas ?? 0),
          `with ${String(readyCount)} ready`,
        ).toBeGreaterThanOrEqual(3);
      }
    });

    it('still counts a merely running container when the template has no probe', () => {
      const unprobed: ContainerTemplate = { image: 'api:v2' };
      const gen = shortDigest(unprobed);
      const observed = observedOf(
        ownedContainer(`web-${gen}-0`, 'web', unprobed, { phase: 'running' }), // ready is undefined
        ownedContainer(`web-${gen}-1`, 'web', unprobed, { phase: 'running' }),
        ...threeOldContainers(),
      );
      const result = expandDeployment(
        { name: 'web', replicas: 3, template: unprobed, strategy: { maxUnavailable: 0 } },
        observed,
        history,
      );
      expect(result.find((rs) => rs.name === `web-${oldName}`)?.replicas).toBe(1); // 3 - 2 - 0
    });
  });

  it('feeding a generated ReplicaSet through expandReplicaSet yields deterministic container names', () => {
    const spec: DeploymentSpec = { name: 'web', replicas: 3, template: deploymentTemplate };
    const observed = observedOf(...threeOldContainers());
    const [newRS] = expandDeployment(spec, observed, history);
    const containers = expandReplicaSet(newRS!, observed);
    expect(containers.map((c) => c.name)).toEqual([`web-${newName}-0`]);
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
