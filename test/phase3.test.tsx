import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  Container,
  Deployment,
  Network,
  Ready,
  Service,
  collectOps,
  createContainerdRuntime,
  createRoot,
  createStatusStore,
  dummy,
  formatOp,
  runArgs,
  serve,
  type ExecResult,
  type Nerdctl,
  type Op,
  type Runtime,
} from '../src/index.js';
import { parseArgs } from '../src/cli.js';

const lines = (ops: readonly Op[]) => ops.map(formatOp);

function setup() {
  const sink = collectOps();
  const root = createRoot({ sink: sink.sink });
  return { root, sink };
}

const createOf = (ops: readonly Op[], id: string) =>
  ops.find(
    (op): op is Extract<Op, { type: 'CREATE'; kind: 'container' }> => op.type === 'CREATE' && op.id === id,
  );

describe('nesting is dependency', () => {
  it('children of a <Container> mount once it is running, and unmount before it', async () => {
    const { root, sink } = setup();
    root.render(
      <Container name="db" image="postgres">
        <Container name="app" image="app" />
        <Container name="worker" image="worker" />
      </Container>,
    );
    expect(lines(sink.take())).toEqual(['CREATE container db image=postgres']);

    root.status.set('db', 'running');
    await root.settle();
    expect(lines(sink.take())).toEqual([
      'CREATE container app image=app',
      'CREATE container worker image=worker',
    ]);

    root.unmount();
    expect(lines(sink.ops)).toEqual([
      'DELETE container app',
      'DELETE container worker',
      'DELETE container db',
    ]);
  });

  it('a container with a readiness probe gates its children on `ready`, not `running`', async () => {
    const { root, sink } = setup();
    root.render(
      <Container name="db" image="postgres" readiness={{ exec: ['pg_isready'] }}>
        <Container name="app" image="app" />
      </Container>,
    );
    sink.take();

    root.status.set('db', 'running');
    await root.settle();
    expect(sink.ops).toEqual([]);

    root.status.mark('db', { ready: true });
    await root.settle();
    expect(lines(sink.ops)).toEqual(['CREATE container app image=app']);
  });

  it('<Ready until="ready"> works for dependencies that are not the parent', async () => {
    const { root, sink } = setup();
    root.render(
      <>
        <Container name="db" image="postgres" readiness={{ exec: ['true'] }} />
        <Ready on="db" until="ready">
          <Container name="app" image="app" />
        </Ready>
      </>,
    );
    sink.take();
    root.status.set('db', 'running');
    root.status.mark('db', { ready: true });
    await root.settle();
    expect(lines(sink.ops)).toEqual(['CREATE container app image=app']);
  });

  it('nesting composes with networks and deployments', async () => {
    const { root, sink } = setup();
    root.render(
      <Network name="app">
        <Container name="db" image="postgres">
          <Deployment name="web" replicas={2}>
            <Container image="nginx" />
          </Deployment>
        </Container>
      </Network>,
    );
    expect(lines(sink.take())).toEqual([
      'CREATE network app',
      'CREATE container db image=postgres network=app',
    ]);
    root.status.set('db', 'running');
    await root.settle();
    expect(lines(sink.ops)).toEqual([
      'CREATE container web-0 image=nginx network=app',
      'CREATE container web-1 image=nginx network=app',
    ]);
  });
});

describe('status.mark', () => {
  it('amends the snapshot without changing state or time, bumps seq, and ignores unknown ids', () => {
    const store = createStatusStore(() => 7);
    let notified = 0;
    store.subscribe(() => notified++);
    expect(store.mark('x', { ready: true })).toBeUndefined();
    expect(notified).toBe(0);

    const running = store.set('x', 'running');
    const marked = store.mark('x', { ready: true })!;
    expect(marked).toMatchObject({ state: 'running', ready: true, at: 7, seq: running.seq + 1 });
    expect(store.get('x')).toBe(marked);

    // The next lifecycle event clears the mark.
    expect(store.set('x', 'dead').ready).toBeUndefined();
  });
});

describe('Service and publish', () => {
  it('<Service> is a caddy reverse proxy in front of its targets', () => {
    const { root, sink } = setup();
    root.render(
      <Service name="web" port={80} targetPort={8080} publish={8000} targets={['web-0', 'web-1']} />,
    );
    const op = createOf(sink.ops, 'web')!;
    expect(op.spec).toEqual({
      name: 'web',
      image: 'docker.io/library/caddy:2-alpine',
      command: ['caddy', 'reverse-proxy', '--from', ':80', '--to', 'web-0:8080', '--to', 'web-1:8080'],
      ports: [80],
      publish: [{ host: 8000, container: 80 }],
    });
  });

  it('a <Service> with no targets renders nothing', () => {
    const { root, sink } = setup();
    root.render(<Service name="web" port={80} targets={[]} />);
    expect(sink.ops).toEqual([]);
  });

  it('<Deployment service> targets its replicas and follows scaling with an UPDATE of the proxy', () => {
    const { root, sink } = setup();
    const app = (replicas: number) => (
      <Deployment name="web" replicas={replicas} service={{ port: 80, publish: 8080 }}>
        <Container image="nginx" />
      </Deployment>
    );
    root.render(app(2));
    expect(lines(sink.take())).toEqual([
      'CREATE container web-0 image=nginx',
      'CREATE container web-1 image=nginx',
      'CREATE container web image=docker.io/library/caddy:2-alpine',
    ]);

    root.render(app(3));
    expect(lines(sink.ops)).toEqual([
      'CREATE container web-2 image=nginx',
      'UPDATE container web changed=[command]',
    ]);
    const update = sink.ops[1]!;
    if (update.type === 'UPDATE' && update.kind === 'container') {
      expect(update.next.command).toContain('web-2:80');
    }
  });

  it('<Deployment service> with named templates needs service.target', () => {
    const { root } = setup();
    expect(() =>
      root.render(
        <Deployment name="app" replicas={1} service={{ port: 80 }}>
          <Container name="api" image="api" />
        </Deployment>,
      ),
    ).toThrow(/service.target/);

    const { root: ok, sink } = setup();
    ok.render(
      <Deployment name="app" replicas={2} service={{ port: 80, target: 'api', name: 'api' }}>
        <Container name="api" image="api" />
        <Container name="sidecar" image="envoy" />
      </Deployment>,
    );
    expect(createOf(sink.ops, 'api')!.spec.command).toEqual([
      'caddy',
      'reverse-proxy',
      '--from',
      ':80',
      '--to',
      'app-api-0:80',
      '--to',
      'app-api-1:80',
    ]);
  });

  it('runArgs publishes host ports', () => {
    const args = runArgs({
      name: 'web',
      image: 'caddy',
      publish: [
        { host: 8080, container: 80 },
        { host: 5353, container: 53, protocol: 'udp' },
      ],
    });
    expect(args.slice(args.indexOf('-p'), args.indexOf('-p') + 4)).toEqual([
      '-p',
      '8080:80',
      '-p',
      '5353:53/udp',
    ]);
  });
});

describe('serve()', () => {
  it('wires a runtime to a tree and stops in order: unmount, idle, abort watch', async () => {
    const events: string[] = [];
    let seenSignal: AbortSignal | undefined;
    const runtime: Runtime = (ctx) => ({
      sink: (ops) => {
        for (const op of ops) events.push(formatOp(op));
        for (const op of ops)
          if (op.type === 'CREATE' && op.kind === 'container') ctx.status.set(op.id, 'running');
      },
      idle: async () => {
        events.push('idle');
      },
      watch: (signal) =>
        new Promise((resolve) => {
          seenSignal = signal;
          signal.addEventListener('abort', () => {
            events.push('watch aborted');
            resolve();
          });
        }),
    });

    const served = serve(
      <Container name="db" image="postgres">
        <Container name="app" image="app" />
      </Container>,
      { runtime },
    );
    await served.root.settle();
    expect(events).toEqual(['CREATE container db image=postgres', 'CREATE container app image=app']);
    expect(seenSignal?.aborted).toBe(false);

    await served.stop();
    expect(events.slice(2)).toEqual(['DELETE container app', 'DELETE container db', 'idle', 'watch aborted']);
  });

  it('the dummy runtime expands readiness-gated subtrees, which is what `plan` relies on', async () => {
    const printed: string[] = [];
    const served = serve(
      <Container name="db" image="postgres" readiness={{ exec: ['pg_isready'] }}>
        <Container name="app" image="app" />
      </Container>,
      { runtime: dummy({ log: (l) => printed.push(l) }) },
    );
    await served.root.settle();
    expect(printed.filter((l) => l.includes('CREATE'))).toEqual([
      '   CREATE container db image=postgres',
      '   CREATE container app image=app',
    ]);
  });
});

describe('containerd readiness prober', () => {
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr = ''): ExecResult => ({ code: 1, stdout: '', stderr });

  function fakeNerdctl(exec: (args: string[]) => ExecResult | Promise<ExecResult>) {
    const calls: string[] = [];
    const nerdctl: Nerdctl = {
      async exec(args) {
        calls.push(args.join(' '));
        return exec([...args]);
      },
      async *stream() {},
    };
    return { nerdctl, calls };
  }

  it('runs the probe inside the container until it passes, then marks the store ready once', async () => {
    let attempts = 0;
    const { nerdctl, calls } = fakeNerdctl((args) => {
      if (args[0] === 'inspect') return fail('no such container');
      if (args[0] === 'exec') return ++attempts >= 3 ? ok() : fail('not yet');
      return ok('a'.repeat(64));
    });
    const status = createStatusStore();
    const runtime = createContainerdRuntime({ nerdctl, status, probeTickMs: 2 });
    runtime.sink([
      {
        type: 'CREATE',
        kind: 'container',
        id: 'db',
        spec: {
          name: 'db',
          image: 'postgres',
          readiness: { exec: ['pg_isready', '-U', 'postgres'], intervalMs: 1 },
        },
      },
    ]);
    await runtime.idle();
    status.set('db', 'running'); // the watcher's job

    const stop = new AbortController();
    const probing = runtime.probe(stop.signal);
    await new Promise((r) => setTimeout(r, 60));
    stop.abort();
    await probing;

    expect(status.get('db')).toMatchObject({ state: 'running', ready: true });
    const probes = calls.filter((c) => c.startsWith('exec'));
    expect(probes).toHaveLength(3);
    expect(probes[0]).toBe('exec db pg_isready -U postgres');
  });

  it('does not probe containers that are not running, and a death during a probe wins', async () => {
    const status = createStatusStore();
    const { nerdctl, calls } = fakeNerdctl(async (args) => {
      if (args[0] === 'exec') {
        status.set('db', 'dead', { exitCode: 1 }); // dies while the probe is in flight
        return ok();
      }
      return args[0] === 'inspect' ? fail() : ok('a'.repeat(64));
    });
    const runtime = createContainerdRuntime({ nerdctl, status, probeTickMs: 2 });
    runtime.sink([
      {
        type: 'CREATE',
        kind: 'container',
        id: 'db',
        spec: { name: 'db', image: 'x', readiness: { exec: ['true'] } },
      },
      { type: 'CREATE', kind: 'container', id: 'plain', spec: { name: 'plain', image: 'x' } },
    ]);
    await runtime.idle();

    const stop = new AbortController();
    const probing = runtime.probe(stop.signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.startsWith('exec'))).toHaveLength(0); // db not running yet

    status.set('db', 'running');
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await probing;

    expect(calls.filter((c) => c.startsWith('exec'))).toHaveLength(1);
    expect(status.get('db')).toMatchObject({ state: 'dead', exitCode: 1 });
    expect(status.get('db').ready).toBeUndefined();
  });
});

describe('cli', () => {
  it('parseArgs separates command, file and flags', () => {
    expect(parseArgs(['up', 'app.tsx', '--namespace', 'dev', '--quiet', '--address=/run/c.sock'])).toEqual({
      command: 'up',
      file: 'app.tsx',
      flags: { namespace: 'dev', quiet: true, address: '/run/c.sock' },
    });
  });

  it('`plan` prints every op the tree would produce, including gated subtrees, and executes nothing', async () => {
    const { stdout } = await promisify(execFile)('npx', ['tsx', 'src/cli.ts', 'plan', 'examples/app.tsx'], {
      cwd: new URL('..', import.meta.url).pathname,
      timeout: 60_000,
    });
    const ops = stdout
      .split('\n')
      .filter((l) => /^\s+(CREATE|UPDATE|DELETE|START)/.test(l))
      .map((l) => l.trim());
    expect(ops).toEqual([
      'CREATE network app',
      'CREATE container db image=postgres:16 network=app',
      'CREATE container web-0 image=nginx:alpine network=app',
      'CREATE container web-1 image=nginx:alpine network=app',
      'CREATE container web image=docker.io/library/caddy:2-alpine network=app',
    ]);
  });
});
