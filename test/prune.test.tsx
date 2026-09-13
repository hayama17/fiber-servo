/**
 * Reaping orphans (issue #9): what containerd holds that the tree no longer
 * declares. Everything here runs against a fake nerdctl or a fake runtime.
 */
import { describe, expect, it } from 'vitest';
import {
  Container,
  Deployment,
  containerd,
  createContainerdRuntime,
  createStatusStore,
  serve,
  specDigest,
  type ExecResult,
  type Nerdctl,
  type PruneKeep,
  type Runtime,
} from '../src/index.js';
import { watchContainerd } from '../src/runtime/containerd/events.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: '', stderr });
const id = (n: number): string => String(n).repeat(64);

let nextId = 0;
const psRow = (name: string, status = 'Up 2 hours', labels = 'fiber-servo.managed=true'): string =>
  JSON.stringify({ ID: id(++nextId % 10), Names: name, Status: status, Labels: labels });

function fakeNerdctl(script: Record<string, (args: string[]) => ExecResult> = {}) {
  const calls: string[] = [];
  const nerdctl: Nerdctl = {
    async exec(args) {
      calls.push(args.join(' '));
      return script[args[0]!]?.([...args]) ?? ok();
    },
    async *stream() {},
  };
  return { nerdctl, calls };
}

describe('containerd runtime: prune', () => {
  it('lists managed containers and networks, and asks nerdctl for nothing else when there is nothing to remove', async () => {
    const { nerdctl, calls } = fakeNerdctl({
      ps: () => ok(psRow('web-0')),
      network: () => ok(JSON.stringify({ Name: 'app', Labels: 'fiber-servo.managed=true' })),
    });
    const runtime = createContainerdRuntime({ nerdctl });

    expect(await runtime.prune({ containers: ['web-0'], networks: ['app'] })).toEqual([]);
    expect(calls).toEqual([
      'ps -a --no-trunc --filter label=fiber-servo.managed=true --format {{json .}}',
      'network ls --format {{json .}}',
    ]);
  });

  it('removes what the tree does not declare, and never touches a foreign resource', async () => {
    const { nerdctl, calls } = fakeNerdctl({
      ps: () =>
        ok(
          [
            psRow('web-0'),
            psRow('web-1'),
            psRow('keepsake', 'Up 3 days', 'com.example.owner=someone-else'),
            'not json',
          ].join('\n'),
        ),
      network: () =>
        ok(
          [
            JSON.stringify({ Name: 'app', Labels: 'fiber-servo.managed=true' }),
            JSON.stringify({ Name: 'gone', Labels: 'fiber-servo.managed=true' }),
            JSON.stringify({ Name: 'bridge', Labels: '' }),
          ].join('\n'),
        ),
    });
    const runtime = createContainerdRuntime({ nerdctl });

    expect(await runtime.prune({ containers: ['web-0'], networks: ['app'] })).toEqual(['web-1', 'gone']);
    expect(calls.filter((c) => c.startsWith('rm') || c.startsWith('network rm'))).toEqual([
      'rm -f web-1',
      'network rm gone',
    ]);
  });

  it('removes containers before networks, so nothing is still attached', async () => {
    const { nerdctl, calls } = fakeNerdctl({
      ps: () => ok([psRow('web-0'), psRow('web-1')].join('\n')),
      network: (args) =>
        args[1] === 'ls' ? ok(JSON.stringify({ Name: 'app', Labels: 'fiber-servo.managed=true' })) : ok(),
    });
    const runtime = createContainerdRuntime({ nerdctl });

    expect(await runtime.prune({ containers: [], networks: [] })).toEqual(['web-0', 'web-1', 'app']);
    expect(calls.filter((c) => c.startsWith('rm') || c.startsWith('network rm'))).toEqual([
      'rm -f web-0',
      'rm -f web-1',
      'network rm app',
    ]);
  });

  it('falls back to network inspect when nerdctl prints no labels in network ls', async () => {
    const { nerdctl, calls } = fakeNerdctl({
      ps: () => ok(''),
      network: (args) => {
        if (args[1] === 'ls')
          return ok([{ Name: 'app' }, { Name: 'bridge' }].map((r) => JSON.stringify(r)).join('\n'));
        if (args[1] === 'inspect') return args.at(-1) === 'app' ? ok('true\n') : ok('\n');
        return ok();
      },
    });
    const runtime = createContainerdRuntime({ nerdctl });

    expect(await runtime.prune({ containers: [], networks: [] })).toEqual(['app']);
    expect(calls).toEqual([
      'ps -a --no-trunc --filter label=fiber-servo.managed=true --format {{json .}}',
      'network ls --format {{json .}}',
      'network inspect --format {{index .Labels "fiber-servo.managed"}} app',
      'network inspect --format {{index .Labels "fiber-servo.managed"}} bridge',
      'network rm app',
    ]);
  });

  it('forgets the status of every container it removed, and keeps going past a refusal', async () => {
    const errors: string[] = [];
    const { nerdctl } = fakeNerdctl({
      ps: () => ok([psRow('web-1'), psRow('web-2')].join('\n')),
      rm: (args) => (args.at(-1) === 'web-1' ? fail('container is paused') : ok()),
    });
    const status = createStatusStore();
    status.set('web-1', 'running');
    status.set('web-2', 'running');
    const runtime = createContainerdRuntime({ nerdctl, status, onError: (e) => errors.push(e.message) });

    expect(await runtime.prune({ containers: [], networks: [] })).toEqual(['web-2']);
    expect(status.get('web-1').state).toBe('running'); // still there, so still watched
    expect(status.get('web-2').state).toBe('unknown');
    expect(errors).toEqual([expect.stringContaining('container is paused')]);
  });

  it('waits for the batch in flight instead of interleaving with it', async () => {
    const order: string[] = [];
    const nerdctl: Nerdctl = {
      async exec(args) {
        await new Promise((r) => setTimeout(r, args[0] === 'run' ? 20 : 0));
        order.push(args.join(' ').split(' ').slice(0, 2).join(' '));
        return args[0] === 'inspect' ? fail('no such container') : ok(id(1));
      },
      async *stream() {},
    };
    const runtime = createContainerdRuntime({ nerdctl });
    runtime.sink([
      { type: 'CREATE', kind: 'container', id: 'web-0', spec: { name: 'web-0', image: 'nginx' } },
    ]);
    await runtime.prune({ containers: ['web-0'], networks: [] });

    expect(order).toEqual(['inspect --format', 'run -d', 'ps -a', 'network ls']);
  });
});

describe('serve(): when pruning happens', () => {
  /** A runtime whose sync reports `adopted` running, as the watcher's first `ps -a` would. */
  function fakeRuntime(adopted: readonly string[]) {
    const keeps: PruneKeep[] = [];
    let sync = (): void => {};
    const synced = new Promise<void>((resolve) => (sync = resolve));
    const runtime: Runtime = (ctx) => ({
      sink: () => {},
      synced,
      async prune(keep) {
        keeps.push({ containers: [...keep.containers], networks: [...keep.networks] });
        return [];
      },
      watch: () =>
        new Promise(() => {
          for (const name of adopted) ctx.status.set(name, 'running');
          sync();
        }),
    });
    return { runtime, keeps, synced };
  }

  it('prunes once the runtime has synced and the tree has settled, keeping what gates opened', async () => {
    const { runtime, keeps } = fakeRuntime(['db']);
    const served = serve(
      <Container name="db" image="postgres">
        <Container name="app" image="app" />
      </Container>,
      { runtime },
    );

    // `app` is only declared after `db` is reported running, which is what the
    // sync does: prune must see both, or it would delete `app` moments later.
    await served.root.settle();
    await new Promise((r) => setImmediate(r));
    // Dependents come first in tree order (decision 14); what matters is that
    // both are in the list.
    expect(keeps).toEqual([{ containers: ['app', 'db'], networks: [] }]);
  });

  it('does nothing when prune is false', async () => {
    const { runtime, keeps } = fakeRuntime(['db']);
    serve(<Container name="db" image="postgres" />, { runtime, prune: false });
    await new Promise((r) => setImmediate(r));
    expect(keeps).toEqual([]);
  });

  it('containerd() offers both halves of the contract', () => {
    const handle = containerd()({ status: createStatusStore(), log: () => {}, onError: () => {} });
    expect(typeof handle.prune).toBe('function');
    expect(handle.synced).toBeInstanceOf(Promise);
  });
});

describe('issue #9: replicas dropped while no session was up', () => {
  it('adopts web-0 and reaps web-1 and web-2', async () => {
    const spec = { name: 'web-0', image: 'nginx' };
    const running = [psRow('web-0'), psRow('web-1'), psRow('web-2')].join('\n');
    const { nerdctl, calls } = fakeNerdctl({
      ps: () => ok(running),
      inspect: (args) =>
        args.at(-1) === 'web-0' ? ok(`${id(1)} true ${specDigest(spec)}\n`) : fail('No such container'),
      network: () => ok(''),
    });

    let pruned: string[] = [];
    const runtime: Runtime = (ctx) => {
      const rt = createContainerdRuntime({ nerdctl, status: ctx.status });
      let sync = (): void => {};
      const synced = new Promise<void>((resolve) => (sync = resolve));
      return {
        sink: rt.sink,
        idle: rt.idle,
        prune: async (keep) => (pruned = await rt.prune(keep)),
        synced,
        watch: (signal) =>
          watchContainerd({ nerdctl, status: ctx.status, signal, onSynced: sync, reconnectDelayMs: 5 }),
      };
    };

    const served = serve(
      <Deployment name="web" replicas={1}>
        <Container image="nginx" />
      </Deployment>,
      { runtime },
    );
    await served.root.settle();
    await new Promise((r) => setTimeout(r, 20));

    expect(pruned).toEqual(['web-1', 'web-2']);
    expect(calls.filter((c) => c.startsWith('rm'))).toEqual(['rm -f web-1', 'rm -f web-2']);
    expect(calls.filter((c) => c.startsWith('run'))).toEqual([]); // web-0 was adopted, not recreated

    await served.stop();
  });
});
