import { describe, expect, it } from 'vitest';
import {
  Container,
  Deployment,
  Network,
  Ready,
  collectOps,
  createDummyRuntime,
  createRoot,
  createStatusStore,
  formatOp,
  readyThenable,
  type Op,
} from '../src/index.js';

const lines = (ops: readonly Op[]) => ops.map(formatOp);

function setup() {
  const sink = collectOps();
  const root = createRoot({ sink: sink.sink });
  return { root, sink };
}

/** The composition the roadmap asked for: one component, several resources. */
function WebApp({ replicas = 2, image = 'nginx' }: { replicas?: number; image?: string }) {
  return (
    <Network name="app">
      <Container name="db" image="postgres:16" restart="never" />
      <Ready on="db">
        <Deployment name="web" replicas={replicas}>
          <Container image={image} env={{ DATABASE_HOST: 'db' }} />
        </Deployment>
      </Ready>
    </Network>
  );
}

describe('phase 2: networks', () => {
  it('a <Network> is created before its containers and deleted after them', () => {
    const { root, sink } = setup();
    root.render(
      <Network name="app">
        <Deployment name="web" replicas={2}>
          <Container image="nginx" />
        </Deployment>
      </Network>,
    );
    expect(lines(sink.take())).toEqual([
      'CREATE network app',
      'CREATE container web-0 image=nginx network=app',
      'CREATE container web-1 image=nginx network=app',
    ]);
    expect(root.liveIds('network')).toEqual(['app']);

    root.unmount();
    expect(lines(sink.ops)).toEqual(['DELETE container web-1', 'DELETE container web-0', 'DELETE network app']);
  });

  it('containers inside a <Network> carry it in their spec; an explicit network prop wins', () => {
    const { root, sink } = setup();
    root.render(
      <Network name="app">
        <Container name="a" image="x" />
        <Container name="b" image="x" network="other" />
      </Network>,
    );
    const creates = sink.ops.filter((op): op is Extract<Op, { type: 'CREATE'; kind: 'container' }> => op.type === 'CREATE' && op.kind === 'container');
    expect(creates.map((op) => [op.id, op.spec.network])).toEqual([
      ['a', 'app'],
      ['b', 'other'],
    ]);
  });

  it('moving a container between networks is an UPDATE with network changed', () => {
    const { root, sink } = setup();
    const app = (net: string) => <Container name="a" image="x" network={net} />;
    root.render(app('one'));
    sink.take();
    root.render(app('two'));
    expect(lines(sink.ops)).toEqual(['UPDATE container a changed=[network]']);
  });

  it('changing a network field other than name is an UPDATE the runtime may refuse', () => {
    const { root, sink } = setup();
    root.render(<Network name="app" subnet="10.1.0.0/24" />);
    sink.take();
    root.render(<Network name="app" subnet="10.2.0.0/24" />);
    expect(lines(sink.ops)).toEqual(['UPDATE network app changed=[subnet]']);
  });

  it('network and container names live in separate namespaces', () => {
    const { root } = setup();
    expect(() =>
      root.render(
        <Network name="web">
          <Container name="web" image="nginx" />
        </Network>,
      ),
    ).not.toThrow();
    expect(root.liveIds('network')).toEqual(['web']);
    expect(root.liveIds()).toEqual(['web']);
  });
});

describe('phase 2: dependency ordering with Suspense', () => {
  it('nothing under <Ready on="db"> mounts until db is reported running', async () => {
    const { root, sink } = setup();
    root.render(
      <>
        <Container name="db" image="postgres" />
        <Ready on="db">
          <Container name="app" image="app" />
        </Ready>
      </>,
    );
    expect(lines(sink.take())).toEqual(['CREATE container db image=postgres']);

    root.status.set('db', 'running');
    await root.settle();

    expect(lines(sink.ops)).toEqual(['CREATE container app image=app']);
  });

  it('a dependency that is already running does not suspend', () => {
    const { root, sink } = setup();
    root.status.set('db', 'running');
    root.render(
      <Ready on="db">
        <Container name="app" image="app" />
      </Ready>,
    );
    expect(lines(sink.ops)).toEqual(['CREATE container app image=app']);
  });

  it('readiness is a latch: a later death of the dependency does not unmount dependents', async () => {
    const { root, sink } = setup();
    root.render(
      <>
        <Container name="db" image="postgres" restart="never" />
        <Ready on="db">
          <Container name="app" image="app" />
        </Ready>
      </>,
    );
    root.status.set('db', 'running');
    await root.settle();
    sink.take();

    root.status.set('db', 'dead');
    await root.settle();
    expect(sink.ops).toEqual([]);
    expect(root.liveIds()).toEqual(['db', 'app']);
  });

  it('waits for every dependency in the list', async () => {
    const { root, sink } = setup();
    root.render(
      <>
        <Container name="db" image="postgres" />
        <Container name="cache" image="redis" />
        <Ready on={['db', 'cache']}>
          <Container name="app" image="app" />
        </Ready>
      </>,
    );
    sink.take();
    root.status.set('db', 'running');
    await root.settle();
    expect(sink.ops).toEqual([]);
    root.status.set('cache', 'running');
    await root.settle();
    expect(lines(sink.ops)).toEqual(['CREATE container app image=app']);
  });

  it('readyThenable is cached per store and id, and settles once', () => {
    const store = createStatusStore();
    const a = readyThenable(store, 'x');
    expect(readyThenable(store, 'x')).toBe(a);
    expect(a.status).toBe('pending');
    const seen: string[] = [];
    a.then((s) => seen.push(s.state));
    store.set('x', 'dead');
    store.set('x', 'running');
    store.set('x', 'running');
    expect(a.status).toBe('fulfilled');
    expect(seen).toEqual(['running']);
    a.then((s) => seen.push(`late:${s.state}`)); // already settled: called synchronously
    expect(seen).toEqual(['running', 'late:running']);
  });
});

describe('phase 2: composition', () => {
  it('<WebApp/> expands to a network, a db, and a gated deployment', async () => {
    const status = createStatusStore();
    const printed: string[] = [];
    const root = createRoot({ status, sink: createDummyRuntime({ log: (l) => printed.push(l), status }) });

    root.render(<WebApp replicas={2} />);
    // db is running (dummy runtime says so) -> the Suspense retry mounts web-*.
    await root.settle();

    expect(printed.filter((l) => l.trim().startsWith('CREATE'))).toEqual([
      '   CREATE network app',
      '   CREATE container db image=postgres:16 network=app',
      '   CREATE container web-0 image=nginx network=app',
      '   CREATE container web-1 image=nginx network=app',
    ]);

    root.render(<WebApp replicas={3} image="nginx:1.27" />);
    await root.settle();
    expect(printed.filter((l) => /UPDATE|CREATE container web-2/.test(l))).toEqual([
      '   UPDATE container web-0 changed=[image]',
      '   UPDATE container web-1 changed=[image]',
      '   CREATE container web-2 image=nginx:1.27 network=app',
    ]);

    root.unmount();
    expect(printed.at(-1)).toBe('   DELETE network app');
  });
});
