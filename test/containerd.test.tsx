import { describe, expect, it } from 'vitest';
import {
  Container,
  Deployment,
  createContainerdRuntime,
  createRoot,
  createStatusStore,
  interpretEvent,
  networkCreateArgs,
  parsePsLine,
  parsePsStatus,
  runArgs,
  specDigest,
  syncFromPs,
  watchContainerd,
  type ExecResult,
  type Nerdctl,
  type Op,
} from '../src/index.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: '', stderr });
const HEX = 'a'.repeat(64);

/**
 * A nerdctl that records argv and answers from a script keyed by subcommand.
 * `stream` yields whatever lines the test pushes, then ends.
 */
function fakeNerdctl(script: Record<string, (args: string[]) => ExecResult> = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const nerdctl: Nerdctl = {
    async exec(args) {
      calls.push(args.join(' '));
      const sub = args[0]!;
      return script[sub]?.([...args]) ?? ok();
    },
    async *stream(args) {
      calls.push(args.join(' '));
      for (const line of lines.splice(0)) yield line;
    },
  };
  return { nerdctl, calls, lines };
}

describe('containerd runtime: ops -> nerdctl argv', () => {
  it('runArgs turns a spec into a detached run with restart handled by us', () => {
    const spec = {
      name: 'web-0',
      image: 'nginx:1.27',
      env: { PORT: '80' },
      labels: { tier: 'web' },
      command: ['nginx', '-g', 'daemon off;'],
    };
    expect(runArgs(spec)).toEqual([
      'run',
      '-d',
      '--name',
      'web-0',
      '--restart=no',
      '--pull=missing',
      '--label',
      'fiber-servo.managed=true',
      '--label',
      `fiber-servo.spec=${specDigest(spec)}`,
      '-e',
      'PORT=80',
      '--label',
      'tier=web',
      'nginx:1.27',
      'nginx',
      '-g',
      'daemon off;',
    ]);
  });

  it('specDigest is order-independent and ignores undefined', () => {
    const a = specDigest({ name: 'x', image: 'i', env: { A: '1', B: '2' }, ports: undefined });
    const b = specDigest({ image: 'i', env: { B: '2', A: '1' }, name: 'x' });
    expect(a).toBe(b);
    expect(specDigest({ name: 'x', image: 'i', env: { A: '1', B: '3' } })).not.toBe(a);
  });

  it('CREATE inspects first and runs when the container does not exist', async () => {
    const { nerdctl, calls } = fakeNerdctl({
      inspect: () => fail('No such container'),
      run: () => ok(`${HEX}\n`),
    });
    const index = new Map<string, string>();
    const runtime = createContainerdRuntime({ nerdctl, index });
    runtime.sink([
      { type: 'CREATE', kind: 'container', id: 'web-0', spec: { name: 'web-0', image: 'nginx' } },
    ]);
    await runtime.idle();

    expect(calls.map((c) => c.split(' ')[0])).toEqual(['inspect', 'run']);
    expect(calls[1]).toContain('--name web-0');
    expect(index.get(HEX)).toBe('web-0');
  });

  it('CREATE adopts an existing container made from the same spec', async () => {
    const spec = { name: 'web-0', image: 'nginx' };
    const stopped = fakeNerdctl({ inspect: () => ok(`${HEX} false ${specDigest(spec)}\n`) });
    const runtime = createContainerdRuntime({ nerdctl: stopped.nerdctl });
    runtime.sink([{ type: 'CREATE', kind: 'container', id: 'web-0', spec }]);
    await runtime.idle();
    expect(stopped.calls.map((c) => c.split(' ')[0])).toEqual(['inspect', 'start']);

    const running = fakeNerdctl({ inspect: () => ok(`${HEX} true ${specDigest(spec)}\n`) });
    const runtime2 = createContainerdRuntime({ nerdctl: running.nerdctl });
    runtime2.sink([{ type: 'CREATE', kind: 'container', id: 'web-0', spec }]);
    await runtime2.idle();
    expect(running.calls.map((c) => c.split(' ')[0])).toEqual(['inspect']);
  });

  it('CREATE recreates an existing container whose spec differs', async () => {
    const { nerdctl, calls } = fakeNerdctl({
      inspect: () => ok(`${HEX} true deadbeef\n`),
      run: () => ok(HEX),
    });
    const runtime = createContainerdRuntime({ nerdctl });
    runtime.sink([
      { type: 'CREATE', kind: 'container', id: 'web-0', spec: { name: 'web-0', image: 'nginx' } },
    ]);
    await runtime.idle();
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['inspect', 'rm', 'run']);
    expect(calls[1]).toBe('rm -f web-0');
  });

  it('UPDATE is rm -f + run with the next spec; DELETE is rm -f and forgets the status', async () => {
    const { nerdctl, calls } = fakeNerdctl({ run: () => ok(HEX) });
    const status = createStatusStore();
    status.set('web-0', 'running');
    const runtime = createContainerdRuntime({ nerdctl, status });
    const prev = { name: 'web-0', image: 'nginx:1' };
    const next = { name: 'web-0', image: 'nginx:2' };
    runtime.sink([{ type: 'UPDATE', kind: 'container', id: 'web-0', prev, next, changed: ['image'] }]);
    runtime.sink([{ type: 'DELETE', kind: 'container', id: 'web-0' }]);
    await runtime.idle();

    expect(calls).toEqual(['rm -f web-0', runArgs(next).join(' '), 'rm -f web-0']);
    expect(status.get('web-0').state).toBe('unknown');
  });

  it('START is nerdctl start; a vanished container is recreated from the last spec', async () => {
    const { nerdctl, calls } = fakeNerdctl({
      inspect: () => fail('No such container'),
      start: () => fail('No such container'),
      run: () => ok(HEX),
    });
    const runtime = createContainerdRuntime({ nerdctl });
    const spec = { name: 'web-0', image: 'nginx' };
    runtime.sink([{ type: 'CREATE', kind: 'container', id: 'web-0', spec }]);
    runtime.sink([{ type: 'START', kind: 'container', id: 'web-0', attempt: 1 }]);
    await runtime.idle();

    expect(calls.map((c) => c.split(' ')[0])).toEqual(['inspect', 'run', 'start', 'inspect', 'run']);
  });

  it('a failed run is reported to the store as dead with the reason, and later ops still execute', async () => {
    const errors: Op[] = [];
    const { nerdctl, calls } = fakeNerdctl({
      inspect: () => fail('No such container'),
      run: (args) => (args.includes('bad:image') ? fail('pull access denied') : ok(HEX)),
    });
    const status = createStatusStore();
    const runtime = createContainerdRuntime({ nerdctl, status, onError: (_e, op) => errors.push(op) });
    runtime.sink([
      { type: 'CREATE', kind: 'container', id: 'a', spec: { name: 'a', image: 'bad:image' } },
      { type: 'CREATE', kind: 'container', id: 'b', spec: { name: 'b', image: 'nginx' } },
    ]);
    await runtime.idle();

    expect(status.get('a')).toMatchObject({
      state: 'dead',
      reason: expect.stringContaining('pull access denied'),
    });
    expect(status.get('b').state).toBe('unknown'); // lifecycle is the watcher's job
    expect(errors.map((op) => op.id)).toEqual(['a']);
    expect(calls.filter((c) => c.startsWith('run')).length).toBe(2);
  });

  it('batches execute strictly in order even though the sink returns immediately', async () => {
    const order: string[] = [];
    const nerdctl: Nerdctl = {
      async exec(args) {
        // The first call is the slowest; ordering must still hold.
        await new Promise((r) => setTimeout(r, args.includes('web-0') ? 20 : 0));
        order.push(args.join(' '));
        return args[0] === 'inspect' ? fail('no') : ok(HEX);
      },
      async *stream() {},
    };
    const runtime = createContainerdRuntime({ nerdctl });
    runtime.sink([
      { type: 'CREATE', kind: 'container', id: 'web-0', spec: { name: 'web-0', image: 'nginx' } },
    ]);
    runtime.sink([{ type: 'DELETE', kind: 'container', id: 'web-0' }]);
    runtime.sink([
      { type: 'CREATE', kind: 'container', id: 'web-1', spec: { name: 'web-1', image: 'nginx' } },
    ]);
    await runtime.idle();

    expect(order.map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
      'inspect --format',
      'run -d',
      'rm -f',
      'inspect --format',
      'run -d',
    ]);
  });
});

describe('containerd runtime: networks', () => {
  it('networkCreateArgs labels the network and passes the subnet', () => {
    const spec = { name: 'app', subnet: '10.9.0.0/24', labels: { tier: 'x' } };
    expect(networkCreateArgs(spec)).toEqual([
      'network',
      'create',
      '--label',
      'fiber-servo.managed=true',
      '--label',
      `fiber-servo.spec=${specDigest(spec)}`,
      '--subnet',
      '10.9.0.0/24',
      '--label',
      'tier=x',
      'app',
    ]);
  });

  it('runArgs attaches to the network named in the spec', () => {
    expect(runArgs({ name: 'a', image: 'x', network: 'app' })).toContain('--network');
    expect(runArgs({ name: 'a', image: 'x' })).not.toContain('--network');
  });

  it('CREATE network creates when missing, adopts ours, uses a foreign one as is, refuses a different spec of ours', async () => {
    const spec = { name: 'app' };
    const run = async (inspect: ExecResult) => {
      const errors: string[] = [];
      const { nerdctl, calls } = fakeNerdctl({ network: (args) => (args[1] === 'inspect' ? inspect : ok()) });
      const runtime = createContainerdRuntime({ nerdctl, onError: (e) => errors.push(e.message) });
      runtime.sink([{ type: 'CREATE', kind: 'network', id: 'app', spec }]);
      await runtime.idle();
      return { calls: calls.map((c) => c.split(' ').slice(0, 2).join(' ')), errors };
    };

    expect(await run(fail('no such network'))).toEqual({
      calls: ['network inspect', 'network create'],
      errors: [],
    });
    expect(await run(ok(`${specDigest(spec)}\n`))).toEqual({ calls: ['network inspect'], errors: [] });
    expect(await run(ok('\n'))).toEqual({ calls: ['network inspect'], errors: [] });
    const refused = await run(ok('other-digest\n'));
    expect(refused.calls).toEqual(['network inspect']);
    expect(refused.errors[0]).toMatch(/immutable/);
  });

  it('DELETE network is network rm; a network UPDATE is reported, not executed', async () => {
    const errors: string[] = [];
    const { nerdctl, calls } = fakeNerdctl();
    const runtime = createContainerdRuntime({ nerdctl, onError: (e) => errors.push(e.message) });
    runtime.sink([
      {
        type: 'UPDATE',
        kind: 'network',
        id: 'app',
        prev: { name: 'app' },
        next: { name: 'app', subnet: '10.0.0.0/24' },
        changed: ['subnet'],
      },
      { type: 'DELETE', kind: 'network', id: 'app' },
    ]);
    await runtime.idle();
    expect(calls).toEqual(['network rm app']);
    expect(errors).toEqual([expect.stringMatching(/network app: \[subnet\] changed/)]);
  });
});

describe('containerd runtime: events -> status store', () => {
  it('parsePsStatus reads docker-style status text', () => {
    expect(parsePsStatus('Up 3 seconds')).toEqual({ state: 'running' });
    expect(parsePsStatus('Exited (137) 2 minutes ago')).toEqual({ state: 'dead', exitCode: 137 });
    expect(parsePsStatus('Created')).toEqual({ state: 'dead' });
    expect(parsePsStatus('???')).toEqual({ state: 'unknown' });
  });

  it('parsePsLine only accepts managed containers', () => {
    const managed = JSON.stringify({
      ID: HEX,
      Names: 'web-0',
      Status: 'Up 1 second',
      Labels: 'fiber-servo.managed=true,fiber-servo.spec=abc',
    });
    const foreign = JSON.stringify({ ID: 'b'.repeat(64), Names: 'other', Status: 'Up', Labels: 'x=y' });
    expect(parsePsLine(managed)).toEqual({ kind: 'set', name: 'web-0', id: HEX, state: 'running' });
    expect(parsePsLine(foreign)).toBeNull();
    expect(parsePsLine('not json')).toBeNull();
  });

  it('interpretEvent maps containerd topics and ignores exec exits and foreign containers', () => {
    const resolve = (id: string) => (id === HEX ? 'web-0' : undefined);
    const row = (Topic: string, body: Record<string, unknown>) => ({
      ID: HEX,
      Topic,
      Event: JSON.stringify(body),
    });

    expect(interpretEvent(row('/tasks/start', { container_id: HEX }), resolve)).toEqual({
      kind: 'set',
      name: 'web-0',
      state: 'running',
    });
    expect(
      interpretEvent(row('/tasks/exit', { container_id: HEX, id: HEX, exit_status: 137 }), resolve),
    ).toEqual({ kind: 'set', name: 'web-0', state: 'dead', exitCode: 137 });
    expect(interpretEvent(row('/tasks/exit', { container_id: HEX, id: HEX }), resolve)).toEqual({
      kind: 'set',
      name: 'web-0',
      state: 'dead',
      exitCode: 0,
    });
    expect(
      interpretEvent(row('/tasks/exit', { container_id: HEX, id: 'exec-1', exit_status: 1 }), resolve),
    ).toBeNull();
    expect(interpretEvent(row('/containers/delete', { id: HEX }), resolve)).toEqual({
      kind: 'remove',
      name: 'web-0',
    });
    expect(interpretEvent(row('/tasks/oom', { container_id: HEX }), resolve)).toBeNull();
    expect(interpretEvent({ ID: 'c'.repeat(64), Topic: '/tasks/start', Event: '{}' }, resolve)).toBeNull();
    // A raw gRPC decode fills proto3 defaults in where nerdctl's JSON omits
    // them: the init exec is then the empty string, not a missing field.
    expect(
      interpretEvent(row('/tasks/exit', { container_id: HEX, id: '', exit_status: 137 }), resolve),
    ).toEqual({ kind: 'set', name: 'web-0', state: 'dead', exitCode: 137 });
    // /containers/delete names the container in `id`, and an envelope decoded
    // from gRPC has no row-level ID to fall back on.
    expect(
      interpretEvent({ Topic: '/containers/delete', Event: JSON.stringify({ id: HEX }) }, resolve),
    ).toEqual({
      kind: 'remove',
      name: 'web-0',
    });
    // ...but `id` on a /tasks/* event is still the process, never the container.
    expect(interpretEvent({ Topic: '/tasks/start', Event: JSON.stringify({ id: HEX }) }, resolve)).toBeNull();
    // nerdctl may hand the body as an object instead of a string
    expect(interpretEvent({ ID: HEX, Topic: '/tasks/start', Event: { container_id: HEX } }, resolve)).toEqual(
      { kind: 'set', name: 'web-0', state: 'running' },
    );
  });

  it('syncFromPs adopts existing managed containers into the store and the index', async () => {
    const rows = [
      { ID: HEX, Names: 'web-0', Status: 'Up 5 minutes', Labels: 'fiber-servo.managed=true' },
      {
        ID: 'b'.repeat(64),
        Names: 'web-1',
        Status: 'Exited (1) 3 seconds ago',
        Labels: 'fiber-servo.managed=true',
      },
      { ID: 'c'.repeat(64), Names: 'not-ours', Status: 'Up', Labels: '' },
    ];
    const { nerdctl, calls } = fakeNerdctl({
      ps: () => ok(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'),
    });
    const status = createStatusStore();
    const index = new Map<string, string>();
    await syncFromPs({ nerdctl, status, index });

    expect(calls).toEqual(['ps -a --no-trunc --format {{json .}}']);
    expect(status.get('web-0').state).toBe('running');
    expect(status.get('web-1')).toMatchObject({ state: 'dead', exitCode: 1 });
    expect(status.get('not-ours').state).toBe('unknown');
    expect([...index.entries()]).toEqual([
      [HEX, 'web-0'],
      ['b'.repeat(64), 'web-1'],
    ]);
  });

  it('watchContainerd resolves unknown ids with inspect once and stops on abort', async () => {
    const { nerdctl, calls, lines } = fakeNerdctl({
      ps: () => ok(''),
      inspect: (args) => (args.at(-1) === HEX ? ok('web-0 true\n') : ok('other \n')),
    });
    lines.push(
      JSON.stringify({
        ID: HEX,
        Topic: '/tasks/exit',
        Event: JSON.stringify({ container_id: HEX, id: HEX, exit_status: 2 }),
      }),
      JSON.stringify({ ID: HEX, Topic: '/tasks/start', Event: JSON.stringify({ container_id: HEX }) }),
      JSON.stringify({
        ID: 'd'.repeat(64),
        Topic: '/tasks/start',
        Event: JSON.stringify({ container_id: 'd'.repeat(64) }),
      }),
      JSON.stringify({
        ID: 'd'.repeat(64),
        Topic: '/tasks/exit',
        Event: JSON.stringify({ container_id: 'd'.repeat(64), id: 'd'.repeat(64) }),
      }),
      'garbage',
    );
    const status = createStatusStore();
    const seen: string[] = [];
    status.subscribe(() => seen.push(status.get('web-0').state));
    const controller = new AbortController();
    const done = watchContainerd({ nerdctl, status, signal: controller.signal, reconnectDelayMs: 1 });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await done;

    expect(seen).toEqual(['dead', 'running']);
    expect(status.get('web-0')).toMatchObject({ state: 'running', seq: 2 });
    expect(calls.filter((c) => c.startsWith('inspect'))).toHaveLength(2); // one per unknown id, cached
    expect(status.entries().has('other')).toBe(false);
  });
});

describe('containerd runtime: end to end with a fake containerd', () => {
  it('the tree, the executor and the watcher form one loop', async () => {
    const { nerdctl, calls } = fakeNerdctl({
      inspect: () => fail('No such container'),
      run: (args) => ok(`${'1'.repeat(63)}${args[3]!.at(-1)}\n`), // id ends with the replica index
      ps: () => ok(''),
    });
    const status = createStatusStore();
    const index = new Map<string, string>();
    const runtime = createContainerdRuntime({ nerdctl, status, index });
    const root = createRoot({ status, sink: runtime.sink });

    root.render(
      <Deployment name="web" replicas={2}>
        <Container image="nginx" restart={{ baseDelayMs: 5 }} />
      </Deployment>,
    );
    await runtime.idle();
    expect(calls.filter((c) => c.startsWith('run'))).toHaveLength(2);
    expect(index.get('1'.repeat(63) + '1')).toBe('web-1');

    // containerd says web-1 died -> the tree asks for a START -> the executor runs `start`.
    const dead = {
      ID: index.get('1'.repeat(63) + '1')!,
      Topic: '/tasks/exit',
      Event: JSON.stringify({ container_id: '1'.repeat(63) + '1', id: '1'.repeat(63) + '1', exit_status: 1 }),
    };
    const { lines } = { lines: [JSON.stringify(dead)] };
    const controller = new AbortController();
    // Deliver each line once; a re-delivered death would re-arm the backoff (by design).
    const streaming: Nerdctl = {
      exec: nerdctl.exec,
      async *stream() {
        yield* lines.splice(0);
      },
    };
    const done = watchContainerd({
      nerdctl: streaming,
      status,
      index,
      signal: controller.signal,
      reconnectDelayMs: 1,
    });
    await new Promise((r) => setTimeout(r, 30));
    root.flush();
    await runtime.idle();
    controller.abort();
    await done;

    expect(calls.filter((c) => c === 'start web-1')).toHaveLength(1);
    expect(calls.filter((c) => c === 'start web-0')).toHaveLength(0);
  });
});
