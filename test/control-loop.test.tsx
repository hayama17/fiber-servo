/**
 * End-to-end tests for the control loop: JSX in, runtime calls out.
 *
 * These run against `createMemoryRuntime`, so they exercise the real
 * controllers and the real restart gate — everything except containerd and
 * everything except an actual `nerdctl compose` process. That is a property
 * of the architecture rather than a testing trick: the runtime boundary is
 * declarative, so any adapter will do.
 */
import { describe, expect, it } from 'vitest';
import { Container, Deployment, Network, Ready, ReplicaSet, Service } from '../src/components.js';
import { createMemoryRuntime, type MemoryRuntime } from '../src/runtime/memory.js';
import { serve, type Served } from '../src/serve.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function containerNames(served: Served): string[] {
  return [...served.observed.snapshot().containers.keys()].sort();
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

describe('a single container', () => {
  it('creates the network-attached container, and observes it running', async () => {
    const { served, runtime } = start(
      <>
        <Network name="demo" />
        <Container name="web" image="nginx:alpine" network="demo" />
      </>,
    );
    await settle(served);

    expect(runtime.calls).toContain('create web image=nginx:alpine');
    expect(served.observed.get('web')?.phase).toBe('running');
    expect(served.observed.get('web')?.networks).toEqual(['demo']);

    await served.stop();
  });

  // A network-only tree changes no service, so before networks entered the
  // plan it produced an empty plan and nothing reached the runtime at all:
  // declaring a network created nothing.
  it('applies a tree that declares only a network', async () => {
    const { served, runtime } = start(<Network name="solo" subnet="10.77.0.0/24" />);
    await settle(served);

    const applied = runtime.calls.filter((c) => c.startsWith('apply '));
    expect(applied.length).toBeGreaterThan(0);

    await served.stop();
  });

  it('applies again when only a network changed', async () => {
    const { served, runtime } = start(
      <>
        <Network name="demo" subnet="10.1.0.0/24" />
        <Container name="web" image="nginx:alpine" network="demo" />
      </>,
    );
    await settle(served);
    const before = runtime.calls.filter((c) => c.startsWith('apply ')).length;

    served.root.render(
      <>
        <Network name="demo" subnet="10.2.0.0/24" />
        <Container name="web" image="nginx:alpine" network="demo" />
      </>,
    );
    await settle(served);

    expect(runtime.calls.filter((c) => c.startsWith('apply ')).length).toBeGreaterThan(before);
    // And the container itself was not disturbed by it.
    expect(served.observed.get('web')?.phase).toBe('running');

    await served.stop();
  });

  it('removes the container when it leaves the tree', async () => {
    const { served, runtime } = start(<Container name="web" image="nginx:alpine" />);
    await settle(served);
    expect(containerNames(served)).toEqual(['web']);

    served.root.render(null);
    await settle(served);

    expect(runtime.calls).toContain('remove web');
    expect(containerNames(served)).toEqual([]);

    await served.stop();
  });
});

describe('replicaset', () => {
  const threeReplicas = (
    <ReplicaSet name="api" replicas={3}>
      <Container image="api:v1" labels={{ app: 'api' }} />
    </ReplicaSet>
  );

  it('creates one container per replica', async () => {
    const { served } = start(threeReplicas);
    await settle(served);

    expect(containerNames(served)).toEqual(['api-0', 'api-1', 'api-2']);

    await served.stop();
  });

  /**
   * The headline behaviour of the whole project. Read the assertion on
   * `commits` carefully: replacing the dead container cost zero React
   * renders, because the tree still says "three" and that was never untrue.
   */
  it('replaces a container that died, without a single React render', async () => {
    const { served, runtime, commits } = start(threeReplicas);
    await settle(served);
    const before = commits();

    runtime.kill('api-1', { exitCode: 137 });
    await settle(served);

    expect(containerNames(served)).toEqual(['api-0', 'api-1', 'api-2']);
    expect(served.observed.get('api-1')?.phase).toBe('running');
    expect(runtime.calls.filter((c) => c === 'create api-1 image=api:v1')).toHaveLength(1);
    expect(runtime.calls.filter((c) => c === 'restart api-1 image=api:v1')).toHaveLength(1);
    expect(commits()).toBe(before);

    await served.stop();
  });

  it('scaling up leaves the existing containers alone', async () => {
    const { served, runtime } = start(threeReplicas);
    await settle(served);
    const callsBefore = runtime.calls.length;

    served.root.render(
      <ReplicaSet name="api" replicas={5}>
        <Container image="api:v1" labels={{ app: 'api' }} />
      </ReplicaSet>,
    );
    await settle(served);

    expect(containerNames(served)).toEqual(['api-0', 'api-1', 'api-2', 'api-3', 'api-4']);
    // Exactly two creations, and nothing touching 0..2.
    const added = runtime.calls.slice(callsBefore);
    expect(added.filter((c) => c.startsWith('create '))).toEqual([
      'create api-3 image=api:v1',
      'create api-4 image=api:v1',
    ]);
    expect(added.some((c) => c.startsWith('remove '))).toBe(false);

    await served.stop();
  });

  it('scaling down removes the highest-numbered containers', async () => {
    const { served } = start(threeReplicas);
    await settle(served);

    served.root.render(
      <ReplicaSet name="api" replicas={1}>
        <Container image="api:v1" labels={{ app: 'api' }} />
      </ReplicaSet>,
    );
    await settle(served);

    expect(containerNames(served)).toEqual(['api-0']);

    await served.stop();
  });
});

describe('the write-path model: every spec change replaces, nothing updates in place', () => {
  /**
   * Under the old op-based write path, a `resources` (cpu/memory) change was
   * the one field applied in place. Compose has no live-update primitive
   * fiber-servo can reach, so that branch is gone: `toComposeService` folds
   * every field, `resources` included, into one spec digest, and the
   * response to *any* difference — cpu now included — is uniformly "replace
   * the service" (see `planner.ts`'s file comment for where this is
   * decided, which is nowhere above the runtime boundary any more).
   */
  it('changing cpu, like any other field, replaces the container', async () => {
    const container = (cpu: number) => <Container name="web" image="nginx:alpine" resources={{ cpu }} />;
    const { served, runtime } = start(container(0.5));
    await settle(served);
    const callsBefore = runtime.calls.length;

    served.root.render(container(1));
    await settle(served);

    const added = runtime.calls.slice(callsBefore);
    expect(added.some((c) => c.startsWith('replace web'))).toBe(true);
  });

  it('changing the image replaces the container', async () => {
    const container = (image: string) => <Container name="web" image={image} />;
    const { served, runtime } = start(container('nginx:1.25'));
    await settle(served);
    const callsBefore = runtime.calls.length;

    served.root.render(container('nginx:1.27'));
    await settle(served);

    const added = runtime.calls.slice(callsBefore);
    expect(added.some((c) => c.startsWith('replace web'))).toBe(true);
  });

  it('changing the network replaces the container', async () => {
    const container = (network: string) => (
      <>
        <Network name="a" />
        <Network name="b" />
        <Container name="web" image="nginx:alpine" network={network} />
      </>
    );
    const { served, runtime } = start(container('a'));
    await settle(served);
    const callsBefore = runtime.calls.length;

    served.root.render(container('b'));
    await settle(served);

    const added = runtime.calls.slice(callsBefore);
    expect(added.some((c) => c.startsWith('replace web'))).toBe(true);
    expect(served.observed.get('web')?.networks).toEqual(['b']);
  });

  it('re-rendering with an unchanged spec touches the runtime not at all', async () => {
    const container = <Container name="web" image="nginx:alpine" />;
    const { served, runtime } = start(container);
    await settle(served);
    const callsBefore = runtime.calls.length;

    served.root.render(<Container name="web" image="nginx:alpine" />);
    await settle(served);

    const added = runtime.calls.slice(callsBefore);
    expect(added.some((c) => /^(create|replace|restart|remove) /.test(c))).toBe(false);
  });
});

describe('deployment', () => {
  const deployment = (image: string) => (
    <Deployment name="api" replicas={2}>
      <Container image={image} labels={{ app: 'api' }} />
    </Deployment>
  );

  it('names containers by template generation, so an edited template rolls over', async () => {
    const { served } = start(deployment('api:v1'));
    await settle(served);
    const first = containerNames(served);
    expect(first).toHaveLength(2);

    served.root.render(deployment('api:v2'));
    await settle(served);
    const second = containerNames(served);

    expect(second).toHaveLength(2);
    // A new generation means new container names, and the old ones are gone.
    expect(second).not.toEqual(first);
    expect(second.some((name) => first.includes(name))).toBe(false);

    await served.stop();
  });
});

describe('service', () => {
  it('puts a proxy container in front of the containers matching its selector', async () => {
    const { served } = start(
      <>
        <Network name="backend" />
        <ReplicaSet name="api" replicas={2}>
          <Container image="api:v1" network="backend" labels={{ app: 'api' }} ports={[8080]} />
        </ReplicaSet>
        <Service name="api-svc" network="backend" selector={{ app: 'api' }} port={80} targetPort={8080} />
      </>,
    );
    await settle(served);

    expect(containerNames(served)).toContain('api-svc');
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

    expect(containerNames(served)).toEqual([]);
    await served.stop();
  });
});

describe('dependency ordering', () => {
  it('holds gated containers back until the dependency is observed running', async () => {
    const { served, runtime } = start(
      <>
        <Container name="db" image="postgres:16" />
        <Ready on="db">
          <Container name="web" image="nginx:alpine" />
        </Ready>
      </>,
    );
    await settle(served);

    expect(containerNames(served)).toEqual(['db', 'web']);
    // The gate is what orders them: db had to be observed running first.
    expect(runtime.calls.indexOf('create db image=postgres:16')).toBeLessThan(
      runtime.calls.indexOf('create web image=nginx:alpine'),
    );

    await served.stop();
  });
});

// ---- restart backoff gate ----------------------------------------------------
//
// Real timers throughout, with generous margins between "definitely still
// held" and "definitely released" checkpoints, rather than fake timers and
// exact-boundary arithmetic — these are testing an escalating *ratio*
// between windows, not a millisecond-exact schedule, so a few milliseconds
// of real scheduling jitter must never be able to flip an assertion.

describe('restart backoff gate', () => {
  /**
   * Excluding a container from the Compose model reads to `Runtime.apply` as
   * "remove it" (see `RestartGate`'s doc comment in `serve.ts`), so the very
   * observation that justified a hold — `exited` — is gone by the next
   * pass: the container is simply `absent`. This test is the one the
   * original bug would have sailed through undetected: if the gate forgot a
   * hold the moment the container disappeared, it would be recreated on the
   * very next pass regardless of backoff, and a naive test asserting only
   * "it comes back eventually" would never notice. So this test asserts the
   * negative first — still absent partway through the window — before
   * asserting it comes back once the window has actually elapsed.
   */
  it('a hold survives the container going from exited to absent', async () => {
    const runtime = createMemoryRuntime();
    const served = serve(<Container name="app" image="app:1" />, {
      runtime: () => runtime,
      restart: { baseDelayMs: 80, factor: 3, maxDelayMs: 10_000 }, // window after the 1st restart: 240ms
    });
    await served.reconcile();
    expect(served.observed.get('app')?.phase).toBe('running');

    // First crash: the first restart is always free, immediate.
    runtime.kill('app');
    await served.idle();
    expect(served.observed.get('app')?.phase).toBe('running');
    expect(runtime.calls.filter((c) => c.startsWith('restart app'))).toHaveLength(1);

    // Second crash, well inside the ~240ms window: held. The runtime
    // orphan-removes it, so it now reads as absent, not exited.
    runtime.kill('app');
    await served.idle();
    expect(served.observed.get('app')).toBeUndefined();

    // Partway through the window: still held, even though the container is
    // `absent` rather than `exited` — this is the assertion that would have
    // caught the original bug.
    await sleep(80);
    expect(served.observed.get('app')).toBeUndefined();

    // Once the window has elapsed, the hold releases and it comes back.
    await sleep(400);
    await served.idle();
    expect(served.observed.get('app')?.phase).toBe('running');

    await served.stop();
  }, 10_000);

  it('escalates the delay for each consecutive crash', async () => {
    const runtime = createMemoryRuntime();
    const served = serve(<Container name="app" image="app:1" />, {
      // window 1 (after 1st restart) = 60*5    = 300ms
      // window 2 (after 2nd restart) = 60*5*5  = 1500ms — strictly bigger
      restart: { baseDelayMs: 60, factor: 5, maxDelayMs: 60_000 },
      runtime: () => runtime,
    });
    await served.reconcile();

    runtime.kill('app'); // 1st crash: free
    await served.idle();
    expect(runtime.calls.filter((c) => c.startsWith('restart app'))).toHaveLength(1);

    runtime.kill('app'); // 2nd crash: held for ~300ms
    await served.idle();
    await sleep(100);
    expect(served.observed.get('app')).toBeUndefined(); // well within the 300ms window
    await sleep(500);
    await served.idle();
    expect(served.observed.get('app')?.phase).toBe('running'); // released

    runtime.kill('app'); // 3rd crash: held for ~1500ms this time
    await served.idle();
    await sleep(500); // bigger than the *previous* window (300ms) — proves escalation
    expect(served.observed.get('app')).toBeUndefined(); // yet still held under the new, longer one
    await sleep(1200);
    await served.idle();
    expect(served.observed.get('app')?.phase).toBe('running'); // eventually released

    await served.stop();
  }, 10_000);

  it('gives up after maxRestarts and never restarts it again', async () => {
    const runtime = createMemoryRuntime();
    const served = serve(<Container name="app" image="app:1" />, {
      runtime: () => runtime,
      restart: { baseDelayMs: 20, factor: 1, maxRestarts: 1 },
    });
    await served.reconcile();

    runtime.kill('app'); // 1st crash: consumes the one allowed restart
    await served.idle();
    expect(runtime.calls.filter((c) => c.startsWith('restart app'))).toHaveLength(1);

    runtime.kill('app'); // 2nd crash: over the cap
    await served.idle();
    expect(served.observed.get('app')).toBeUndefined();

    // Even long after whatever window would otherwise have applied, it never
    // comes back — `maxRestarts` is a hard stop, not just a longer wait.
    await sleep(500);
    await served.idle();
    expect(served.observed.get('app')).toBeUndefined();
    // Still only the one restart from before the cap — the 2nd crash never
    // earned another one, however long we wait.
    expect(runtime.calls.filter((c) => c.startsWith('restart app'))).toHaveLength(1);

    await served.stop();
  }, 10_000);

  // A restart history is about a thing that was run, not about a name. The
  // failure this guards against is silent: a container that crash-looped to
  // `maxRestarts` under a broken image stayed given up on after the image
  // was fixed, because the give-up was keyed on the name alone — and the
  // warning had already been logged, so nothing said anything ever again.
  describe('spec identity', () => {
    async function crashToGiveUp(runtime: MemoryRuntime, served: Served): Promise<void> {
      await served.reconcile();
      runtime.kill('app'); // 1st crash: consumes the single allowed restart
      await served.idle();
      runtime.kill('app'); // 2nd: over the cap
      await served.idle();
      expect(served.observed.get('app')).toBeUndefined();
    }

    it('starts a fixed container again even after the broken one was given up on', async () => {
      const runtime = createMemoryRuntime();
      const served = serve(<Container name="app" image="broken:v1" />, {
        runtime: () => runtime,
        restart: { baseDelayMs: 20, factor: 1, maxRestarts: 1 },
      });
      await crashToGiveUp(runtime, served);

      // The fix: same container, different image. It has never failed.
      served.root.render(<Container name="app" image="fixed:v2" />);
      await settle(served);

      expect(served.observed.get('app')?.phase).toBe('running');
      expect(served.observed.get('app')?.image).toBe('fixed:v2');

      await served.stop();
    }, 10_000);

    it('keeps giving up while the spec is unchanged', async () => {
      const runtime = createMemoryRuntime();
      const served = serve(<Container name="app" image="broken:v1" />, {
        runtime: () => runtime,
        restart: { baseDelayMs: 20, factor: 1, maxRestarts: 1 },
      });
      await crashToGiveUp(runtime, served);

      // Re-rendering the very same spec is not a fix, and must not read as one.
      served.root.render(<Container name="app" image="broken:v1" />);
      await settle(served);
      await sleep(300);
      await served.idle();

      expect(served.observed.get('app')).toBeUndefined();
      await served.stop();
    }, 10_000);

    it('does not carry a held backoff across a spec change either', async () => {
      const runtime = createMemoryRuntime();
      const served = serve(<Container name="app" image="broken:v1" />, {
        runtime: () => runtime,
        // A 30s window: if the fixed spec inherited this hold, it could not
        // possibly come back inside this test.
        restart: { baseDelayMs: 30_000, factor: 1, maxDelayMs: 60_000 },
      });
      await served.reconcile();
      runtime.kill('app'); // free restart, opens a 30s window
      await served.idle();
      runtime.kill('app'); // held for 30s
      await served.idle();
      expect(served.observed.get('app')).toBeUndefined();

      served.root.render(<Container name="app" image="fixed:v2" />);
      await settle(served);

      expect(served.observed.get('app')?.image).toBe('fixed:v2');
      await served.stop();
    }, 10_000);
  });

  it('resets the backoff after the container has stayed up for resetAfterMs', async () => {
    const runtime = createMemoryRuntime();
    const served = serve(<Container name="app" image="app:1" />, {
      runtime: () => runtime,
      // A huge factor means "still escalating" would force a long wait
      // before a second crash is admitted — so an *immediate* restart after
      // resetAfterMs has elapsed can only mean the record was really reset,
      // not merely that this crash happened to land inside a short window.
      restart: { baseDelayMs: 500, factor: 50, maxDelayMs: 120_000, resetAfterMs: 200 },
    });
    await served.reconcile();

    runtime.kill('app'); // 1st crash: free, and starts the gate's clock
    await served.idle();
    expect(runtime.calls.filter((c) => c.startsWith('restart app'))).toHaveLength(1);

    // Stay healthy well past resetAfterMs, with nothing crashing.
    await sleep(400);

    // A fresh crash now should be treated as first-ever again: immediate,
    // not held for the escalated (50x) delay a still-live record would have
    // demanded.
    runtime.kill('app');
    await served.idle();
    expect(served.observed.get('app')?.phase).toBe('running');
    expect(runtime.calls.filter((c) => c.startsWith('restart app'))).toHaveLength(2);

    await served.stop();
  }, 10_000);
});
