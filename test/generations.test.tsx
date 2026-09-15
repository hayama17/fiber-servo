import { describe, expect, it } from 'vitest';
import { Container, Deployment } from '../src/components.js';
import { expandDeployment, expandReplicaSet, GENERATION_LABEL, OWNER_LABEL } from '../src/controllers.js';
import { createGenerationHistory } from '../src/generations.js';
import { createObservedStore } from '../src/observed.js';
import { digest, shortDigest, type ContainerTemplate, type DeploymentSpec } from '../src/resources.js';
import { createMemoryRuntime } from '../src/runtime/memory.js';
import type { ObservedContainer, ObservedState } from '../src/runtime/types.js';
import { serve, type Served } from '../src/serve.js';

/**
 * A template far larger than a containerd label may hold. It is the whole
 * point: 4096 bytes per label key+value is a real limit, and controller
 * history stopped being label-shaped the moment a template could exceed it.
 * Nothing below should get slower or more fragile as this grows.
 */
const big: ContainerTemplate = {
  image: 'api:v1',
  command: ['./server'],
  env: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`VAR_${String(i)}`, 'x'.repeat(64)])),
  network: 'backend',
  resources: { cpu: 0.5, memory: '512m' },
  readiness: { exec: ['/health'] },
  labels: { app: 'api' },
};
const v2: ContainerTemplate = { ...big, image: 'api:v2' };

const EMPTY: ObservedState = { containers: new Map(), revision: 0 };
const observedOf = (containers: ObservedContainer[]): ObservedState => ({
  containers: new Map(containers.map((c) => [c.name, c])),
  revision: 1,
});

describe('createGenerationHistory', () => {
  it('remembers a template under its own generation identity', () => {
    const history = createGenerationHistory();
    history.remember(big);
    expect(history.all().get(digest(big))).toEqual(big);
  });

  it('holds a template of any size, because it is not going into a label', () => {
    const history = createGenerationHistory();
    history.remember(big);
    expect(JSON.stringify(history.all().get(digest(big))).length).toBeGreaterThan(4096);
  });

  it('drops what prune does not keep', () => {
    const history = createGenerationHistory();
    history.remember(big);
    history.remember(v2);
    history.prune([digest(v2)]);
    expect([...history.all().keys()]).toEqual([digest(v2)]);
  });
});

// Within one process, an old generation is reproduced exactly. That is what
// the history is for, and the only thing it is for.
describe('draining an old generation within one process', () => {
  const spec: DeploymentSpec = { name: 'web', replicas: 2, template: v2 };

  /** What a runtime reports back for the containers generation `big` produced. */
  function running(): ObservedContainer[] {
    const generation = digest(big);
    return expandReplicaSet({ name: `web-${shortDigest(big)}`, replicas: 2, template: big }, EMPTY).map(
      (c, i) => {
        const labels = { ...c.labels, [OWNER_LABEL]: 'web', [GENERATION_LABEL]: generation };
        return {
          name: c.name,
          phase: 'running' as const,
          networks: ['backend'],
          image: c.image,
          labels,
          specDigest: digest({ ...c, labels }),
          at: i + 1,
        };
      },
    );
  }

  /** The history a live `serve()` would hold after the template was edited. */
  function history() {
    const h = createGenerationHistory();
    h.remember(big);
    h.remember(v2);
    return h.all();
  }

  it('recovers the old template field for field', () => {
    const old = expandDeployment(spec, observedOf(running()), history()).find(
      (rs) => rs.name === `web-${shortDigest(big)}`,
    );
    expect(old?.template).toEqual(big);
  });

  it('brings a container that died mid-rollout back with the identical spec', () => {
    const alive = running();
    const [killed] = alive;
    const observed = observedOf(alive.slice(1));

    const regenerated = expandDeployment(spec, observed, history())
      .flatMap((rs) =>
        expandReplicaSet(rs, observed).map((c) => ({
          ...c,
          labels: { ...c.labels, [OWNER_LABEL]: 'web', [GENERATION_LABEL]: digest(rs.template) },
        })),
      )
      .find((c) => c.name === killed!.name);

    expect(regenerated).toBeDefined();
    expect(digest(regenerated)).toBe(killed!.specDigest);
  });

  it('does not invent a template for a generation it has no record of', () => {
    const forgotten = createGenerationHistory();
    forgotten.remember(v2); // only the current template — as after a restart

    const names = expandDeployment(spec, observedOf(running()), forgotten.all()).map((rs) => rs.name);
    expect(names).toEqual([`web-${shortDigest(v2)}`]);
  });
});

// And the statement of what a restart actually promises, end to end: not that
// the rollout continues, but that the machine converges on what the tree says
// now. The runtime survives; the control plane does not.
describe('a restart converges freshly rather than resuming', () => {
  async function settle(served: Served, rounds = 25): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await served.root.settle();
      await served.idle();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  it('removes the old generation it can no longer describe, and reaches the new one', async () => {
    // One runtime throughout: the containers outlive the process, as they do
    // in reality. Only the control plane is replaced.
    const runtime = createMemoryRuntime();

    const first = serve(
      <Deployment name="web" replicas={2} strategy={{ maxSurge: 2 }}>
        <Container {...big} />
      </Deployment>,
      { runtime: () => runtime, restart: { baseDelayMs: 1, factor: 1 } },
    );
    await settle(first);
    const beforeRestart = [...first.observed.snapshot().containers.keys()];
    expect(beforeRestart).toHaveLength(2);
    expect(beforeRestart.every((n) => n.startsWith(`web-${shortDigest(big)}-`))).toBe(true);

    // The process goes away. `detach()` is what that looks like from inside:
    // the control plane stops, the containers do not. Anything weaker leaves
    // the old loop subscribed to the runtime, still reconciling, still able
    // to apply its own stale desired state over the top of its replacement —
    // which is not a restart, it is two control planes.
    const historyBefore = createGenerationHistory();
    await first.detach();
    const callsAtDetach = runtime.calls.length;

    const second = serve(
      <Deployment name="web" replicas={2} strategy={{ maxSurge: 2 }}>
        <Container {...v2} />
      </Deployment>,
      {
        runtime: () => runtime,
        observed: createObservedStore(),
        generations: historyBefore, // a fresh one, to show it starts empty
        restart: { baseDelayMs: 1, factor: 1 },
      },
    );
    await settle(second);

    const after = [...second.observed.snapshot().containers.keys()].sort();
    expect(after).toHaveLength(2);
    expect(after.every((n) => n.startsWith(`web-${shortDigest(v2)}-`))).toBe(true);
    expect(runtime.calls.some((c) => c.startsWith(`remove web-${shortDigest(big)}-`))).toBe(true);

    // The detached control plane took no further part: every call after the
    // handover was made by the new one, and none of them recreated v1.
    expect(
      runtime.calls.slice(callsAtDetach).some((c) => c.includes(shortDigest(big)) && c.startsWith('create')),
    ).toBe(false);

    // Controller history belongs to the React Deployment component. The
    // detached tree's history does not cross the control-plane boundary.
    expect([...historyBefore.all().keys()]).toEqual([]);

    await second.stop();
  }, 20_000);

  it('detach leaves the runtime alone, where stop tears it down', async () => {
    const runtime = createMemoryRuntime();
    const served = serve(<Container name="solo" image="api:v1" />, {
      runtime: () => runtime,
      restart: { baseDelayMs: 1, factor: 1 },
    });
    await settle(served);
    expect(runtime.calls.some((c) => c.startsWith('create solo'))).toBe(true);

    await served.detach();

    // Still there, and the adapter was never asked to remove anything.
    expect((await runtime.inspect()).containers.has('solo')).toBe(true);
    expect(runtime.calls.some((c) => c.startsWith('remove solo'))).toBe(false);
    expect(runtime.calls.some((c) => c.startsWith('down'))).toBe(false);
  }, 20_000);

  it('a detached control plane does not react to the runtime any more', async () => {
    const runtime = createMemoryRuntime();
    const served = serve(<Container name="solo" image="api:v1" />, {
      runtime: () => runtime,
      restart: { baseDelayMs: 1, factor: 1 },
    });
    await settle(served);
    await served.detach();
    const callsAtDetach = runtime.calls.length;

    // A container dying is exactly what a live control plane would act on.
    runtime.kill('solo');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runtime.calls.slice(callsAtDetach).filter((c) => !c.startsWith('kill '))).toEqual([]);
    // Its observed state is now stale rather than empty, which is the point:
    // it is not watching any more, so it still believes what it last saw.
    expect(served.observed.get('solo')?.phase).toBe('running');
    expect((await runtime.inspect()).containers.get('solo')?.phase).toBe('exited');
  }, 20_000);
});

