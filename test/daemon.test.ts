import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMessageDecoder,
  defaultSocketPath,
  encodeMessage,
  parseRequest,
  type DaemonRequest,
  type DaemonResponse,
} from '../src/daemon/protocol.js';
import { sendRequest } from '../src/daemon/client.js';
import { claimSocketPath, createAppRegistry, startDaemon } from '../src/daemon/server.js';
import { formatOp, type Runtime } from '../src/index.js';

// Not a dot-directory: tsconfig `include` skips those, and tsx would then
// compile the JSX classically. Short, because a unix socket path is capped
// near 104 bytes.
const dir = fileURLToPath(new URL('./tmp-daemon/', import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(dir, { recursive: true, force: true });
});

/** An app file that declares `replicas` nginx containers. */
const deployment = (replicas: number, image = 'nginx') => `
  import { Container, Deployment } from '../../src/index.js';
  export default () => (
    <Deployment name="web" replicas={${replicas}}>
      <Container image="${image}" />
    </Deployment>
  );
`;

async function writeApp(name: string, source: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = `${dir}${name}`;
  await writeFile(file, source);
  return file;
}

/** Poll until `done` holds, or give up loudly. */
async function until(done: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A runtime that records ops and reports every container it creates running. */
function recordingRuntime(ops: string[]): Runtime {
  return (ctx) => ({
    sink: (batch) => {
      for (const op of batch) {
        ops.push(formatOp(op));
        if (op.kind !== 'container') continue;
        if (op.type === 'CREATE' || op.type === 'START') ctx.status.set(op.id, 'running');
        if (op.type === 'DELETE') ctx.status.remove(op.id);
      }
    },
    idle: () => Promise.resolve(),
  });
}

describe('daemon protocol framing', () => {
  const requests: DaemonRequest[] = [
    { cmd: 'apply', file: '/srv/app.tsx', watch: true },
    { cmd: 'delete', file: '/srv/app.tsx' },
    { cmd: 'list' },
    { cmd: 'ping' },
  ];

  it('round-trips every request through one frame', () => {
    const decode = createMessageDecoder<DaemonRequest>();
    for (const request of requests) expect(decode(encodeMessage(request))).toEqual([request]);
  });

  it('holds a line split across chunks until its newline arrives', () => {
    const decode = createMessageDecoder<DaemonRequest>();
    const frame = encodeMessage(requests[0]!);
    const cut = Math.floor(frame.length / 2);
    expect(decode(Buffer.from(frame.slice(0, cut)))).toEqual([]);
    expect(decode(Buffer.from(frame.slice(cut)))).toEqual([requests[0]]);
  });

  it('returns two requests delivered in one chunk, in order', () => {
    const decode = createMessageDecoder<DaemonRequest>();
    const chunk = encodeMessage(requests[0]!) + encodeMessage(requests[2]!);
    expect(decode(Buffer.from(chunk))).toEqual([requests[0], requests[2]]);
  });

  it('survives a multi-byte character split across chunks', () => {
    const decode = createMessageDecoder<DaemonResponse>();
    const frame = Buffer.from(encodeMessage({ type: 'log', line: 'reloaded /srv/日本.tsx' }));
    // Cut inside the first multi-byte character of the path.
    const cut = frame.indexOf(Buffer.from('日')) + 1;
    expect(decode(frame.subarray(0, cut))).toEqual([]);
    expect(decode(frame.subarray(cut))).toEqual([{ type: 'log', line: 'reloaded /srv/日本.tsx' }]);
  });

  it('rejects a request that is not one of the four commands', () => {
    expect(parseRequest({ cmd: 'apply', file: '/a.tsx' })).toEqual({
      cmd: 'apply',
      file: '/a.tsx',
      watch: false,
    });
    expect(() => parseRequest({ cmd: 'scale', replicas: 3 })).toThrow(/unknown command/);
    expect(() => parseRequest({ cmd: 'apply' })).toThrow(/needs a "file"/);
    expect(() => parseRequest('apply')).toThrow(/must be an object/);
  });

  it('takes the socket path from the environment, most specific first', () => {
    expect(defaultSocketPath({ FIBER_SERVO_SOCK: '/tmp/a.sock', XDG_RUNTIME_DIR: '/run/user/1' })).toBe(
      '/tmp/a.sock',
    );
    expect(defaultSocketPath({ XDG_RUNTIME_DIR: '/run/user/1' })).toBe('/run/user/1/fiber-servo.sock');
    expect(defaultSocketPath({})).toBe('/run/fiber-servo.sock');
  });
});

describe('app registry', () => {
  it('mounts on the first apply, diffs on the next, and unmounts on delete', async () => {
    const ops: string[] = [];
    const registry = createAppRegistry({ runtime: recordingRuntime(ops) });
    cleanups.push(() => registry.close());
    const file = await writeApp('a.tsx', deployment(1));

    const first = await registry.apply(file);
    expect(ops.splice(0)).toEqual(['CREATE container web-0 image=nginx']);
    expect(first.id).toBe(file);
    expect(first.containers).toEqual(['web-0']);

    // Same program, one more replica: React diffs, so only the new one is an op.
    await writeApp('a.tsx', deployment(2));
    const second = await registry.apply(file);
    expect(ops.splice(0)).toEqual(['CREATE container web-1 image=nginx']);
    expect(second.containers).toEqual(['web-0', 'web-1']);

    // A changed image is an UPDATE per replica, never a recreate.
    await writeApp('a.tsx', deployment(2, 'nginx:alpine'));
    await registry.apply(file);
    expect(ops.splice(0)).toEqual([
      'UPDATE container web-0 changed=[image]',
      'UPDATE container web-1 changed=[image]',
    ]);

    const removed = await registry.remove(file);
    expect(removed.containers).toEqual(['web-0', 'web-1']);
    expect(ops.splice(0)).toEqual(['DELETE container web-0', 'DELETE container web-1']);
    expect(registry.list()).toEqual([]);
  });

  it('keeps apps apart: deleting one leaves the other running', async () => {
    const ops: string[] = [];
    const registry = createAppRegistry({ runtime: recordingRuntime(ops) });
    cleanups.push(() => registry.close());
    const one = await writeApp('one.tsx', deployment(1));
    const two = await writeApp(
      'two.tsx',
      `
      import { Container } from '../../src/index.js';
      export default () => <Container name="db" image="postgres" />;
    `,
    );

    await registry.apply(one);
    await registry.apply(two);
    ops.splice(0);
    expect(registry.list().map((app) => app.id)).toEqual([one, two]);

    await registry.remove(one);
    expect(ops.splice(0)).toEqual(['DELETE container web-0']);
    expect(registry.list().map((app) => app.containers)).toEqual([['db']]);
  });

  it('refuses to delete a file it never applied, and keeps the previous tree when one fails to load', async () => {
    const ops: string[] = [];
    const registry = createAppRegistry({ runtime: recordingRuntime(ops) });
    cleanups.push(() => registry.close());
    const file = await writeApp('bad.tsx', deployment(1));

    await expect(registry.remove(`${dir}never.tsx`)).rejects.toThrow(/is not applied/);

    await registry.apply(file);
    ops.splice(0);
    await writeApp('bad.tsx', 'export default 42;');
    await expect(registry.apply(file)).rejects.toThrow(/must default-export/);
    // The live evaluation is untouched: nothing was deleted.
    expect(ops).toEqual([]);
    expect(registry.list()[0]?.containers).toEqual(['web-0']);
  });

  it('unions every app into one prune keep set, once the runtime has synced', async () => {
    const keeps: { containers: readonly string[]; networks: readonly string[] }[] = [];
    let synced = false;
    const runtime: Runtime = (ctx) => ({
      sink: (batch) => {
        for (const op of batch)
          if (op.type === 'CREATE' && op.kind === 'container') ctx.status.set(op.id, 'running');
      },
      synced: Promise.resolve().then(() => {
        synced = true;
      }),
      prune: (keep) => {
        expect(synced).toBe(true);
        keeps.push(keep);
        return Promise.resolve([]);
      },
    });
    const registry = createAppRegistry({ runtime });
    cleanups.push(() => registry.close());

    await registry.apply(await writeApp('one.tsx', deployment(2)));
    await registry.apply(
      await writeApp(
        'two.tsx',
        `
        import { Container, Network } from '../../src/index.js';
        export default () => (
          <Network name="app">
            <Container name="db" image="postgres" />
          </Network>
        );
      `,
      ),
    );

    expect(keeps.at(-1)).toEqual({ containers: ['web-0', 'web-1', 'db'], networks: ['app'] });
  });
});

describe('daemon over a unix socket', () => {
  async function daemonOn(name: string, ops: string[] = []) {
    await mkdir(dir, { recursive: true });
    const socketPath = `${dir}${name}`;
    const daemon = await startDaemon({ runtime: recordingRuntime(ops), socketPath, log: () => {} });
    cleanups.push(() => daemon.close());
    return { daemon, socketPath };
  }

  it('applies, re-applies, deletes and lists over the socket, then shuts down', async () => {
    const ops: string[] = [];
    const { daemon, socketPath } = await daemonOn('d.sock', ops);
    const file = await writeApp('a.tsx', deployment(1));

    expect(await sendRequest({ cmd: 'ping' }, { socketPath })).toMatchObject({ ok: true, pid: process.pid });

    const streamed: DaemonResponse[] = [];
    const applied = await sendRequest(
      { cmd: 'apply', file },
      { socketPath, onMessage: (m) => streamed.push(m) },
    );
    expect(applied).toMatchObject({ type: 'done', ok: true, id: file });
    expect(streamed.filter((m) => m.type === 'op').map((m) => m.line)).toEqual([
      'CREATE container web-0 image=nginx',
    ]);
    expect(streamed.filter((m) => m.type === 'status')).toEqual([
      { type: 'status', id: 'web-0', state: 'running' },
    ]);

    await writeApp('a.tsx', deployment(2));
    const again: DaemonResponse[] = [];
    const reapplied = await sendRequest(
      { cmd: 'apply', file },
      { socketPath, onMessage: (m) => again.push(m) },
    );
    expect(reapplied.ok).toBe(true);
    // Only the difference: web-0 is not touched by the second evaluation.
    expect(again.filter((m) => m.type === 'op').map((m) => m.line)).toEqual([
      'CREATE container web-1 image=nginx',
    ]);

    expect(await sendRequest({ cmd: 'list' }, { socketPath })).toMatchObject({
      ok: true,
      apps: [{ id: file, watching: false, containers: ['web-0', 'web-1'] }],
    });

    const deleted = await sendRequest({ cmd: 'delete', file }, { socketPath });
    expect(deleted).toMatchObject({ ok: true, id: file });
    expect(ops.slice(-2)).toEqual(['DELETE container web-0', 'DELETE container web-1']);
    expect(await sendRequest({ cmd: 'list' }, { socketPath })).toMatchObject({ ok: true, apps: [] });

    await daemon.close();
    cleanups.pop();
    await expect(sendRequest({ cmd: 'ping' }, { socketPath })).rejects.toThrow(/no daemon listening/);
  }, 30_000);

  it('watches on request, re-evaluates on save, and stops watching on delete', async () => {
    const ops: string[] = [];
    const { socketPath } = await daemonOn('w.sock', ops);
    const file = await writeApp('a.tsx', deployment(1));

    const done = await sendRequest({ cmd: 'apply', file, watch: true }, { socketPath });
    expect(done.apps?.[0]?.watching).toBe(true);
    ops.splice(0);

    // The client is long gone; the daemon holds the evaluation and re-runs it.
    await writeApp('a.tsx', deployment(2));
    await until(() => ops.includes('CREATE container web-1 image=nginx'));

    await sendRequest({ cmd: 'delete', file }, { socketPath });
    ops.splice(0);
    await writeApp('a.tsx', deployment(3));
    await new Promise((r) => setTimeout(r, 500));
    expect(ops).toEqual([]);
  }, 30_000);

  it('answers a failed command with ok:false rather than closing on the client', async () => {
    const { socketPath } = await daemonOn('e.sock');
    const done = await sendRequest({ cmd: 'delete', file: `${dir}never.tsx` }, { socketPath });
    expect(done).toMatchObject({ type: 'done', ok: false });
    expect(done.message).toMatch(/is not applied/);
  });

  it('unmounts every app when it shuts down', async () => {
    const ops: string[] = [];
    const { daemon, socketPath } = await daemonOn('f.sock', ops);
    await sendRequest({ cmd: 'apply', file: await writeApp('a.tsx', deployment(2)) }, { socketPath });
    ops.splice(0);
    await daemon.close();
    cleanups.pop();
    expect(ops).toEqual(['DELETE container web-0', 'DELETE container web-1']);
  });
});

describe('stale socket files', () => {
  it('removes a socket path nothing is listening on', async () => {
    await mkdir(dir, { recursive: true });
    const socketPath = `${dir}g.sock`;
    // What a killed daemon leaves behind: a path that exists and answers nothing.
    await writeFile(socketPath, '');
    await claimSocketPath(socketPath);

    const daemon = await startDaemon({ runtime: recordingRuntime([]), socketPath });
    cleanups.push(() => daemon.close());
    expect(await sendRequest({ cmd: 'ping' }, { socketPath })).toMatchObject({ ok: true });
  });

  it('refuses to start on a path a live daemon already holds', async () => {
    await mkdir(dir, { recursive: true });
    const socketPath = `${dir}h.sock`;
    const daemon = await startDaemon({ runtime: recordingRuntime([]), socketPath });
    cleanups.push(() => daemon.close());

    await expect(startDaemon({ runtime: recordingRuntime([]), socketPath })).rejects.toThrow(
      /already listening/,
    );
    // The live one still has its socket.
    expect(await sendRequest({ cmd: 'ping' }, { socketPath })).toMatchObject({ ok: true });
  });
});
