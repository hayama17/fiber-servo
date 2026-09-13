import { useEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Container, Deployment, collectOps, createRoot, formatOp, type Op } from '../src/index.js';

/** Compact view of an op list so assertions read like the spec. */
const lines = (ops: readonly Op[]) => ops.map(formatOp);

function setup() {
  const sink = collectOps();
  const root = createRoot({ sink: sink.sink });
  return { root, sink };
}

describe('phase 0: ops from the fiber tree, nothing executed', () => {
  it('<Deployment replicas={3}> emits CREATE x3 with the container spec', () => {
    const { root, sink } = setup();
    root.render(
      <Deployment name="web" replicas={3}>
        <Container image="nginx" />
      </Deployment>,
    );

    expect(lines(sink.ops)).toEqual([
      'CREATE container web-0 image=nginx',
      'CREATE container web-1 image=nginx',
      'CREATE container web-2 image=nginx',
    ]);
    expect(sink.ops[0]).toEqual({
      type: 'CREATE',
      kind: 'container',
      id: 'web-0',
      spec: { name: 'web-0', image: 'nginx' },
    });
    expect(sink.batches).toHaveLength(1);
    expect(root.liveIds()).toEqual(['web-0', 'web-1', 'web-2']);
  });

  it('scaling 3 -> 5 emits exactly CREATE x2 for the new replicas', () => {
    const { root, sink } = setup();
    const app = (replicas: number) => (
      <Deployment name="web" replicas={replicas}>
        <Container image="nginx" />
      </Deployment>
    );
    root.render(app(3));
    sink.take();

    root.render(app(5));

    expect(lines(sink.ops)).toEqual([
      'CREATE container web-3 image=nginx',
      'CREATE container web-4 image=nginx',
    ]);
    expect(root.liveIds()).toEqual(['web-0', 'web-1', 'web-2', 'web-3', 'web-4']);
  });

  it('scaling 5 -> 2 emits exactly DELETE x3 for the removed replicas', () => {
    const { root, sink } = setup();
    const app = (replicas: number) => (
      <Deployment name="web" replicas={replicas}>
        <Container image="nginx" />
      </Deployment>
    );
    root.render(app(5));
    sink.take();

    root.render(app(2));

    expect(lines(sink.ops).sort()).toEqual([
      'DELETE container web-2',
      'DELETE container web-3',
      'DELETE container web-4',
    ]);
    expect(root.liveIds()).toEqual(['web-0', 'web-1']);
  });

  it('changing image emits UPDATE for every instance, no CREATE or DELETE', () => {
    const { root, sink } = setup();
    const app = (image: string) => (
      <Deployment name="web" replicas={3}>
        <Container image={image} />
      </Deployment>
    );
    root.render(app('nginx:1.26'));
    sink.take();

    root.render(app('nginx:1.27'));

    expect(lines(sink.ops)).toEqual([
      'UPDATE container web-0 changed=[image]',
      'UPDATE container web-1 changed=[image]',
      'UPDATE container web-2 changed=[image]',
    ]);
    expect(sink.ops[1]).toEqual({
      type: 'UPDATE',
      kind: 'container',
      id: 'web-1',
      prev: { name: 'web-1', image: 'nginx:1.26' },
      next: { name: 'web-1', image: 'nginx:1.27' },
      changed: ['image'],
    });
  });

  it('re-rendering with equal props emits nothing', () => {
    const { root, sink } = setup();
    const app = () => (
      <Deployment name="web" replicas={2}>
        <Container image="nginx" env={{ PORT: '80' }} ports={[80]} />
      </Deployment>
    );
    root.render(app());
    sink.take();

    root.render(app()); // new prop objects, same values

    expect(sink.ops).toEqual([]);
    expect(sink.batches).toHaveLength(1); // no empty batches either
  });

  it('UPDATE reports every changed key and carries structural diffs', () => {
    const { root, sink } = setup();
    root.render(<Container name="db" image="postgres:16" env={{ A: '1' }} ports={[5432]} />);
    sink.take();

    root.render(<Container name="db" image="postgres:17" env={{ A: '1', B: '2' }} ports={[5432]} />);

    expect(sink.ops).toHaveLength(1);
    const op = sink.ops[0]!;
    expect(op.type).toBe('UPDATE');
    if (op.type === 'UPDATE') expect(op.changed).toEqual(['image', 'env']);
  });

  it('scale and image change in one render produce UPDATE for old and CREATE for new', () => {
    const { root, sink } = setup();
    root.render(
      <Deployment name="web" replicas={2}>
        <Container image="nginx:1" />
      </Deployment>,
    );
    sink.take();

    root.render(
      <Deployment name="web" replicas={3}>
        <Container image="nginx:2" />
      </Deployment>,
    );

    expect(lines(sink.ops)).toEqual([
      'UPDATE container web-0 changed=[image]',
      'UPDATE container web-1 changed=[image]',
      'CREATE container web-2 image=nginx:2',
    ]);
  });

  it('unmount emits DELETE for every live container', () => {
    const { root, sink } = setup();
    root.render(
      <Deployment name="web" replicas={2}>
        <Container image="nginx" />
      </Deployment>,
    );
    sink.take();

    root.unmount();

    expect(lines(sink.ops).sort()).toEqual(['DELETE container web-0', 'DELETE container web-1']);
    expect(root.liveIds()).toEqual([]);
  });

  it('renaming a container is DELETE + CREATE, because name is identity', () => {
    const { root, sink } = setup();
    root.render(<Container name="a" image="nginx" />);
    sink.take();

    root.render(<Container name="b" image="nginx" />);

    expect(lines(sink.ops)).toEqual(['DELETE container a', 'CREATE container b image=nginx']);
    expect(root.liveIds()).toEqual(['b']);
  });

  it('a Deployment with several templates names each replica after its template', () => {
    const { root, sink } = setup();
    root.render(
      <Deployment name="app" replicas={2}>
        <Container name="api" image="api:1" />
        <Container name="sidecar" image="envoy" />
      </Deployment>,
    );

    expect(root.liveIds()).toEqual(['app-api-0', 'app-sidecar-0', 'app-api-1', 'app-sidecar-1']);
    expect(sink.ops.every((op) => op.type === 'CREATE')).toBe(true);
  });

  it('nested containers are created parents-first and deleted children-first', () => {
    const { root, sink } = setup();
    root.render(
      <Container name="outer" image="pause">
        <Container name="inner" image="app" />
      </Container>,
    );
    expect(lines(sink.take())).toEqual([
      'CREATE container outer image=pause',
      'CREATE container inner image=app',
    ]);

    root.unmount();
    expect(lines(sink.ops)).toEqual(['DELETE container inner', 'DELETE container outer']);
  });

  it('state-driven re-renders go through the same op path', () => {
    const { root, sink } = setup();
    let scale: (n: number) => void = () => {};
    function App() {
      const [replicas, setReplicas] = useState(1);
      useEffect(() => {
        scale = setReplicas;
      }, []);
      return (
        <Deployment name="web" replicas={replicas}>
          <Container image="nginx" />
        </Deployment>
      );
    }
    root.render(<App />);
    expect(lines(sink.take())).toEqual(['CREATE container web-0 image=nginx']);

    scale(3);
    root.render(<App />); // flush; the state update is already queued

    expect(lines(sink.ops)).toEqual([
      'CREATE container web-1 image=nginx',
      'CREATE container web-2 image=nginx',
    ]);
  });
});

describe('phase 0: invariants', () => {
  it('ops are delivered only at commit, one batch per commit', () => {
    const batchesSeenDuringRender: number[] = [];
    const sink = collectOps();
    const root = createRoot({ sink: sink.sink });
    function Probe({ image }: { image: string }) {
      batchesSeenDuringRender.push(sink.batches.length);
      return <Container name="p" image={image} />;
    }

    root.render(<Probe image="a" />);
    root.render(<Probe image="b" />);

    // Render of commit N sees exactly N-1 batches: nothing leaks mid-render.
    expect(batchesSeenDuringRender).toEqual([0, 1]);
    expect(sink.batches.map(lines)).toEqual([
      ['CREATE container p image=a'],
      ['UPDATE container p changed=[image]'],
    ]);
  });

  it('rejects text in the tree', () => {
    const { root } = setup();
    expect(() => root.render(<Container name="x" image="nginx">hello</Container>)).toThrow(
      /text is not allowed/,
    );
  });

  it('rejects unknown host elements', () => {
    const { root } = setup();
    // Bypass the typed helpers on purpose.
    const Bad = 'div' as unknown as (props: Record<string, never>) => null;
    expect(() => root.render(<Bad />)).toThrow(/unknown host element <div>/);
  });

  it('rejects duplicate container names', () => {
    const { root } = setup();
    expect(() =>
      root.render(
        <>
          <Container name="dup" image="a" />
          <Container name="dup" image="b" />
        </>,
      ),
    ).toThrow(/duplicate container name "dup"/);
  });

  it('rejects a Container without a name outside a Deployment', () => {
    const { root } = setup();
    expect(() => root.render(<Container image="nginx" />)).toThrow(/needs a "name"/);
  });
});
