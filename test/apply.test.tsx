/**
 * Session ownership and explicit `apply`, end to end: one `up` owns an entry
 * file, `apply` re-evaluates it on demand, and the endpoint is released
 * cleanly on shutdown. These run the real CLI against `--runtime memory`
 * (`src/runtime/memory.ts`), which implements the full adapter contract, so
 * an idempotent re-apply genuinely produces no actions rather than that being
 * an assumption about a stub.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCli, cli } from './cli-helper.js';
import { Container, Pod } from '../src/components.js';
import { requestApply, listenSession } from '../src/control.js';
import { createSession } from '../src/session.js';

const root = fileURLToPath(new URL('..', import.meta.url));
beforeAll(buildCli);

describe('explicit apply', () => {
  it('keeps edits pending, refreshes local imports, reports no-ops/errors, and tears down the session', async () => {
    const dir = await mkdtemp(join(root, 'test/tmp-apply-'));
    const file = join(dir, 'app.tsx');
    const config = join(dir, 'config.ts');
    // A plain ReplicaSet, so scaling is just "create the newly-desired Pods":
    // no template-generation digest in the names to work around in assertions.
    const app = `import { Container, Pod, ReplicaSet } from 'fiber-servo';
      import { replicas } from './config.js';
      export default () => (
        <ReplicaSet name="web" replicas={replicas}>
          <Pod><Container name="app" image="nginx" /></Pod>
        </ReplicaSet>
      );`;
    await writeFile(file, app);
    await writeFile(config, 'export const replicas = 1;');
    const up = cli(['up', file, '--runtime', 'memory']);
    try {
      await up.until('session ready');
      await writeFile(config, 'export const replicas = 3;');
      await new Promise((r) => setTimeout(r, 200));
      // No --watch: editing an imported module does nothing until asked.
      expect(up.output()).not.toContain('create-pod web-1');
      const apply = cli(['apply', file]);
      expect(await apply.exited).toBe(0);
      expect(apply.output()).toContain('create-pod web-1');
      expect(apply.output()).toContain('create-pod web-2');
      expect(apply.output()).not.toContain('remove-pod web-0');
      // Re-applying the same file is a true no-op: the planner compares
      // against the spec each Pod was created from, not against a diff of
      // the previous render.
      expect((await requestApply(file)).ops).toEqual([]);

      const duplicate = cli(['up', file, '--runtime', 'memory']);
      expect(await duplicate.exited).toBe(1);
      expect(duplicate.output()).not.toContain('create-pod');

      await writeFile(config, 'export const replicas = ;');
      const bad = cli(['apply', file]);
      expect(await bad.exited).toBe(1);
      expect(bad.output()).toContain('keeping the previous tree');
      expect(up.output()).not.toContain('remove-pod');

      await writeFile(config, 'export const replicas = 1;');
      const result = await requestApply(file);
      expect(result.ok).toBe(true);
      expect(result.ops.filter((op) => op.startsWith('remove-pod'))).toHaveLength(2);
      await up.stop();
      expect(up.output()).toContain('remove-pod web-0');
      await expect(requestApply(file, 1000)).rejects.toThrow('Cannot contact session');

      // A clean stop releases the address for the next session.
      const again = cli(['up', file, '--runtime', 'memory']);
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
        // A minimal Runtime that never actually records anything it "creates":
        // every reconcile pass reads desired vs *observed* state fresh
        // (serve.ts's `pass()`), so a Pod that was never observed is desired
        // but missing on every single pass, not just the first. That is what
        // lets this runtime stay this small and still prove the session
        // queues applies and surfaces each one's own errors.
        runtime: (ctx) => ({
          async createNetwork() {},
          async removeNetwork() {},
          async createPod() {
            events.push('create-pod');
            ctx.onError(new Error('runtime refused create'));
          },
          async removePod() {
            events.push('remove-pod');
          },
          async createContainer() {},
          async removeContainer() {},
          async updateContainerResources() {},
          async inspect() {
            return { pods: new Map(), networks: new Map(), revision: 0 };
          },
          subscribe() {
            return () => {};
          },
        }),
      },
      async () => {
        loads++;
        if (loads === 1) await gate;
        return (
          <Pod name="web">
            <Container name="app" image="nginx" />
          </Pod>
        );
      },
    );
    const first = session.apply();
    const second = session.apply();
    const stopping = session.stop();
    expect((await session.apply()).ok).toBe(false);
    release();
    expect((await first).errors).toEqual(['runtime refused create']);
    // The first create was never observed as succeeding, so the second apply
    // finds the same Pod still missing and tries again — and fails again.
    expect((await second).errors).toEqual(['runtime refused create']);
    await stopping;
    expect(loads).toBe(2);
    // Nothing was ever actually provisioned, so there is nothing for the
    // shutdown unmount to remove.
    expect(events).toEqual(['create-pod', 'create-pod']);
    await session.stop();
    expect(events).toEqual(['create-pod', 'create-pod']);
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
