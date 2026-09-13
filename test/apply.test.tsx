import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCli, cliWrapper } from './cli-helper.js';
import { Container } from '../src/components.js';
import { requestApply, listenSession } from '../src/control.js';
import { createSession } from '../src/session.js';

const root = fileURLToPath(new URL('..', import.meta.url));
beforeAll(buildCli);

function cli(args: string[]) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', cliWrapper, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr!.on('data', (data: Buffer) => {
    output += data.toString();
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  return {
    child,
    exited,
    output: () => output,
    async until(text: string) {
      for (let i = 0; i < 400; i++) {
        if (output.includes(text)) return;
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`Missing ${text}\n${output}`);
    },
    async stop() {
      if (child.exitCode === null && child.connected) child.send('stop');
      await exited;
    },
  };
}

describe('explicit apply', () => {
  it('keeps edits pending, refreshes local imports, reports no-ops/errors, and tears down the session', async () => {
    const dir = await mkdtemp(join(root, 'test/tmp-apply-'));
    const file = join(dir, 'app.tsx');
    const config = join(dir, 'config.ts');
    const app = `import { Container, Deployment } from 'fiber-servo';
      import { replicas } from './config.js';
      export default () => <Deployment name="web" replicas={replicas}><Container image="nginx" /></Deployment>;`;
    await writeFile(file, app);
    await writeFile(config, 'export const replicas = 1;');
    const up = cli(['up', file, '--runtime', 'dummy']);
    try {
      await up.until('session ready');
      await writeFile(config, 'export const replicas = 3;');
      await new Promise((r) => setTimeout(r, 200));
      expect(up.output()).not.toContain('CREATE container web-1');
      const apply = cli(['apply', file]);
      expect(await apply.exited).toBe(0);
      expect(apply.output()).toContain('CREATE container web-1');
      expect(apply.output()).toContain('CREATE container web-2');
      expect(apply.output()).not.toContain('DELETE container web-0');
      expect((await requestApply(file)).ops).toEqual([]);

      const duplicate = cli(['up', file, '--runtime', 'dummy']);
      expect(await duplicate.exited).toBe(1);
      expect(duplicate.output()).not.toContain('CREATE container');

      await writeFile(config, 'export const replicas = ;');
      const bad = cli(['apply', file]);
      expect(await bad.exited).toBe(1);
      expect(bad.output()).toContain('keeping the previous tree');
      expect(up.output()).not.toContain('op DELETE');

      await writeFile(config, 'export const replicas = 1;');
      const result = await requestApply(file);
      expect(result.ok).toBe(true);
      expect(result.ops.filter((op) => op.startsWith('DELETE'))).toHaveLength(2);
      await up.stop();
      expect(up.output()).toContain('DELETE container web-0');
      await expect(requestApply(file, 1000)).rejects.toThrow('Cannot contact session');

      // A clean stop releases the address for the next session.
      const again = cli(['up', file, '--runtime', 'dummy']);
      try {
        await again.until('session ready');
      } finally {
        await again.stop();
      }
    } finally {
      await up.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('serializes apply and shutdown, and returns runtime errors to the caller', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const events: string[] = [];
    let loads = 0;
    const session = createSession(
      {
        runtime: (ctx) => ({
          sink(ops) {
            for (const op of ops) {
              events.push(op.type);
              if (op.type === 'CREATE') ctx.onError(new Error('runtime refused create'));
            }
          },
        }),
      },
      async () => {
        loads++;
        if (loads === 1) await gate;
        return <Container name="web" image="nginx" restart="never" />;
      },
    );
    const first = session.apply();
    const second = session.apply();
    const stopping = session.stop();
    expect((await session.apply()).ok).toBe(false);
    release();
    expect((await first).errors).toEqual(['runtime refused create']);
    expect((await second).ok).toBe(true);
    await stopping;
    expect(loads).toBe(2);
    expect(events).toEqual(['CREATE', 'DELETE']);
    await session.stop();
    expect(events).toEqual(['CREATE', 'DELETE']);
  });

  it('reports a client timeout without claiming the operation was cancelled', async () => {
    const file = join(root, `test/timeout-${Date.now()}.tsx`);
    let release!: () => void;
    const close = await listenSession(
      file,
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, ops: [], errors: [] });
        }),
    );
    try {
      await expect(requestApply(file, 100)).rejects.toThrow('may still be running');
    } finally {
      release?.();
      await close();
    }
  });
});
