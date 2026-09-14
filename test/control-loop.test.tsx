/**
 * End-to-end tests for the control loop: JSX in, runtime calls out.
 *
 * These run against `createMemoryRuntime`, so they exercise the real
 * controllers, the real planner and the real backoff — everything except
 * containerd. That is a property of the architecture rather than a testing
 * trick: the runtime boundary is declarative, so any adapter will do.
 */
import { describe, expect, it } from 'vitest';
import { Container, Deployment, Network, Pod, Ready, ReplicaSet, Service } from '../src/components.js';
import { createMemoryRuntime, type MemoryRuntime } from '../src/runtime/memory.js';
import { serve, type Served } from '../src/serve.js';

/**
 * Drive React and the control loop until neither has anything left to do.
 * Both can wake the other — a commit triggers a reconcile, an observation
 * triggers a render — so quiescence needs a few rounds.
 */
async function settle(served: Served, rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await served.root.settle();
    await served.idle();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function podNames(served: Served): string[] {
  return [...served.observed.snapshot().pods.keys()].sort();
}

function start(element: React.ReactNode): { served: Served; runtime: MemoryRuntime; commits: () => number } {
  const runtime = createMemoryRuntime();
  let commits = 0;
  const served = serve(element, {
    runtime: () => runtime,
    // Backoff is seconds in production; make it immediate here.
    restart: { baseDelayMs: 1, factor: 1 },
    onDesired: () => {
      commits += 1;
    },
  });
  return { served, runtime, commits: () => commits };
}

describe('a single pod', () => {
  it('creates the network and the pod, and observes it running', async () => {
    const { served, runtime } = start(
      <>
        <Network name="demo" />
        <Pod name="web" network="demo">
          <Container name="nginx" image="nginx:alpine" />
        </Pod>
      </>,
    );
    await settle(served);

    expect(runtime.calls).toContain('createNetwork demo');
    expect(runtime.calls).toContain('createPod web');
    expect(served.observed.getPod('web')?.phase).toBe('running');

    await served.stop();
  });

  it('removes the pod when it leaves the tree', async () => {
    const { served, runtime } = start(
      <Pod name="web">
        <Container name="nginx" image="nginx:alpine" />
      </Pod>,
    );
    await settle(served);
    expect(podNames(served)).toEqual(['web']);

    served.root.render(null);
    await settle(served);

    expect(runtime.calls).toContain('removePod web');
    expect(podNames(served)).toEqual([]);

    await served.stop();
  });
});

describe('replicaset', () => {
  const threeReplicas = (
    <ReplicaSet name="api" replicas={3}>
      <Pod labels={{ app: 'api' }}>
        <Container name="app" image="api:v1" />
      </Pod>
    </ReplicaSet>
  );

  it('creates one pod per replica', async () => {
    const { served } = start(threeReplicas);
    await settle(served);

    expect(podNames(served)).toEqual(['api-0', 'api-1', 'api-2']);

    await served.stop();
  });

  /**
   * The headline behaviour of the whole project. Read the assertion on
   * `commits` carefully: replacing the dead Pod cost zero React renders,
   * because the tree still says "three" and that was never untrue.
   */
  it('replaces a pod that died, without a single React render', async () => {
    const { served, runtime, commits } = start(threeReplicas);
    await settle(served);
    const before = commits();

    runtime.kill('api-1', { exitCode: 137 });
    await settle(served);

    expect(podNames(served)).toEqual(['api-0', 'api-1', 'api-2']);
    expect(served.observed.getPod('api-1')?.phase).toBe('running');
    expect(runtime.calls.filter((c) => c === 'createPod api-1')).toHaveLength(2);
    expect(commits()).toBe(before);

    await served.stop();
  });

  it('scaling up leaves the existing pods alone', async () => {
    const { served, runtime } = start(threeReplicas);
    await settle(served);
    const callsBefore = runtime.calls.length;

    served.root.render(
      <ReplicaSet name="api" replicas={5}>
        <Pod labels={{ app: 'api' }}>
          <Container name="app" image="api:v1" />
        </Pod>
      </ReplicaSet>,
    );
    await settle(served);

    expect(podNames(served)).toEqual(['api-0', 'api-1', 'api-2', 'api-3', 'api-4']);
    // Exactly two creations, and nothing touching 0..2.
    const added = runtime.calls.slice(callsBefore);
    expect(added.filter((c) => c.startsWith('createPod'))).toEqual(['createPod api-3', 'createPod api-4']);
    expect(added.some((c) => c.startsWith('removePod'))).toBe(false);

    await served.stop();
  });

  it('scaling down removes the highest-numbered pods', async () => {
    const { served } = start(threeReplicas);
    await settle(served);

    served.root.render(
      <ReplicaSet name="api" replicas={1}>
        <Pod labels={{ app: 'api' }}>
          <Container name="app" image="api:v1" />
        </Pod>
      </ReplicaSet>,
    );
    await settle(served);

    expect(podNames(served)).toEqual(['api-0']);

    await served.stop();
  });
});

describe('the immutability model', () => {
  it('changing cpu updates in place and does not recreate the pod', async () => {
    const pod = (cpu: number) => (
      <Pod name="web">
        <Container name="nginx" image="nginx:alpine" resources={{ cpu }} />
      </Pod>
    );
    const { served, runtime } = start(pod(0.5));
    await settle(served);
    const callsBefore = runtime.calls.length;

    served.root.render(pod(1));
    await settle(served);

    const added = runtime.calls.slice(callsBefore);
    expect(added.some((c) => c.startsWith('updateContainerResources'))).toBe(true);
    expect(added.some((c) => c.startsWith('removePod') || c.startsWith('createPod'))).toBe(false);

    await served.stop();
  });

  it('changing the image replaces the container but keeps the sandbox', async () => {
    const pod = (image: string) => (
      <Pod name="web">
        <Container name="nginx" image={image} />
      </Pod>
    );
    const { served, runtime } = start(pod('nginx:1.25'));
    await settle(served);
    const callsBefore = runtime.calls.length;

    served.root.render(pod('nginx:1.27'));
    await settle(served);

    const added = runtime.calls.slice(callsBefore);
    expect(added).toContain('removeContainer web/nginx');
    expect(added).toContain('createContainer web/nginx');
    expect(added.some((c) => c.startsWith('removePod'))).toBe(false);

    await served.stop();
  });

  it('changing the network replaces the whole pod', async () => {
    const pod = (network: string) => (
      <>
        <Network name="a" />
        <Network name="b" />
        <Pod name="web" network={network}>
          <Container name="nginx" image="nginx:alpine" />
        </Pod>
      </>
    );
    const { served, runtime } = start(pod('a'));
    await settle(served);
    const callsBefore = runtime.calls.length;

    served.root.render(pod('b'));
    await settle(served);

    const added = runtime.calls.slice(callsBefore);
    expect(added).toContain('removePod web');
    expect(added).toContain('createPod web');

    await served.stop();
  });
});

describe('deployment', () => {
  const deployment = (image: string) => (
    <Deployment name="api" replicas={2}>
      <Pod labels={{ app: 'api' }}>
        <Container name="app" image={image} />
      </Pod>
    </Deployment>
  );

  it('names pods by template generation, so an edited template rolls over', async () => {
    const { served } = start(deployment('api:v1'));
    await settle(served);
    const first = podNames(served);
    expect(first).toHaveLength(2);

    served.root.render(deployment('api:v2'));
    await settle(served);
    const second = podNames(served);

    expect(second).toHaveLength(2);
    // A new generation means new pod names, and the old ones are gone.
    expect(second).not.toEqual(first);
    expect(second.some((name) => first.includes(name))).toBe(false);

    await served.stop();
  });
});

describe('service', () => {
  it('puts a proxy pod in front of the pods matching its selector', async () => {
    const { served } = start(
      <>
        <Network name="backend" />
        <ReplicaSet name="api" replicas={2}>
          <Pod network="backend" labels={{ app: 'api' }}>
            <Container name="app" image="api:v1" ports={[8080]} />
          </Pod>
        </ReplicaSet>
        <Service name="api-svc" network="backend" selector={{ app: 'api' }} port={80} targetPort={8080} />
      </>,
    );
    await settle(served);

    expect(podNames(served)).toContain('api-svc');
    await served.stop();
  });

  it('has no proxy while nothing matches the selector', async () => {
    const { served } = start(
      <>
        <Network name="backend" />
        <Service name="api-svc" network="backend" selector={{ app: 'nothing' }} port={80} />
      </>,
    );
    await settle(served);

    expect(podNames(served)).toEqual([]);
    await served.stop();
  });
});

describe('dependency ordering', () => {
  it('holds gated pods back until the dependency is observed running', async () => {
    const { served, runtime } = start(
      <>
        <Pod name="db">
          <Container name="postgres" image="postgres:16" />
        </Pod>
        <Ready on="db">
          <Pod name="web">
            <Container name="nginx" image="nginx:alpine" />
          </Pod>
        </Ready>
      </>,
    );
    await settle(served);

    expect(podNames(served)).toEqual(['db', 'web']);
    // The gate is what orders them: db had to be observed running first.
    expect(runtime.calls.indexOf('createPod db')).toBeLessThan(runtime.calls.indexOf('createPod web'));

    await served.stop();
  });
});
