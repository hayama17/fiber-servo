import { describe, expect, it } from 'vitest';
import { toComposeApplication } from '../src/compose.js';
import type { ComposeApplication } from '../src/compose.js';
import type { ContainerSpec } from '../src/resources.js';
import { createMemoryRuntime } from '../src/runtime/memory.js';
import type { RuntimeEvent } from '../src/runtime/types.js';

function app(containers: ContainerSpec[], project = 'test'): ComposeApplication {
  return toComposeApplication(containers, [], project);
}

const one: ContainerSpec = { name: 'api-0', image: 'app:1' };

describe('memory runtime: apply() creating a container', () => {
  it('shows up in inspect() running, with a spec digest and its labels', async () => {
    const runtime = createMemoryRuntime();
    await runtime.apply(app([one]));

    const state = await runtime.inspect();
    const observed = state.containers.get('api-0');
    expect(observed).toBeDefined();
    expect(observed?.phase).toBe('running');
    expect(observed?.image).toBe('app:1');
    expect(observed?.specDigest).toBeDefined();
    expect(observed?.labels['fiber-servo.managed']).toBe('true');
  });

  it('reports a container carrying a readiness probe as ready by default', async () => {
    const runtime = createMemoryRuntime();
    const withProbe: ContainerSpec = { ...one, readiness: { exec: ['true'] } };
    await runtime.apply(app([withProbe]));

    const state = await runtime.inspect();
    expect(state.containers.get('api-0')?.ready).toBe(true);
  });

  it('autoStart: false leaves the container waiting', async () => {
    const runtime = createMemoryRuntime({ autoStart: false });
    await runtime.apply(app([one]));

    const state = await runtime.inspect();
    expect(state.containers.get('api-0')?.phase).toBe('waiting');
  });

  it('autoReady: false leaves a probed container not-ready even when running', async () => {
    const runtime = createMemoryRuntime({ autoReady: false });
    const withProbe: ContainerSpec = { ...one, readiness: { exec: ['true'] } };
    await runtime.apply(app([withProbe]));

    const state = await runtime.inspect();
    expect(state.containers.get('api-0')?.ready).toBe(false);
  });

  it('a container with no readiness probe never reports `ready` at all', async () => {
    const runtime = createMemoryRuntime();
    await runtime.apply(app([one]));
    expect((await runtime.inspect()).containers.get('api-0')?.ready).toBeUndefined();
  });
});

describe('memory runtime: apply() idempotence', () => {
  it('an unchanged model is a true no-op: same id, no new event, same revision', async () => {
    const runtime = createMemoryRuntime();
    const model = app([one]);
    await runtime.apply(model);
    const before = await runtime.inspect();
    const idBefore = before.containers.get('api-0')!.id;

    const events: RuntimeEvent[] = [];
    runtime.subscribe((e) => {
      events.push(e);
    });
    await runtime.apply(model);

    const after = await runtime.inspect();
    expect(after.containers.get('api-0')!.id).toBe(idBefore); // left completely alone
    expect(after.revision).toBe(before.revision);
    expect(events).toEqual([]);
  });

  it('a different spec digest replaces the container: new id, new image', async () => {
    const runtime = createMemoryRuntime();
    await runtime.apply(app([one]));
    const idBefore = (await runtime.inspect()).containers.get('api-0')!.id;

    await runtime.apply(app([{ ...one, image: 'app:2' }]));

    const after = (await runtime.inspect()).containers.get('api-0')!;
    expect(after.id).not.toBe(idBefore);
    expect(after.image).toBe('app:2');
  });

  it('an exited container is restarted on the next apply of the same model: new id, running again', async () => {
    const runtime = createMemoryRuntime();
    const model = app([one]);
    await runtime.apply(model);
    const idBefore = (await runtime.inspect()).containers.get('api-0')!.id;

    runtime.kill('api-0', { exitCode: 137 });
    expect((await runtime.inspect()).containers.get('api-0')?.phase).toBe('exited');

    await runtime.apply(model);

    const after = (await runtime.inspect()).containers.get('api-0')!;
    expect(after.id).not.toBe(idBefore);
    expect(after.phase).toBe('running');
    expect(after.exitCode).toBeUndefined();
  });

  it('a service the model no longer declares is removed as an orphan', async () => {
    const runtime = createMemoryRuntime();
    const other: ContainerSpec = { name: 'sidecar', image: 'proxy:1' };
    await runtime.apply(app([one, other]));

    const events: RuntimeEvent[] = [];
    runtime.subscribe((e) => {
      events.push(e);
    });
    await runtime.apply(app([one])); // `sidecar` dropped from the model

    expect((await runtime.inspect()).containers.has('sidecar')).toBe(false);
    expect((await runtime.inspect()).containers.has('api-0')).toBe(true);
    expect(events).toContainEqual({ type: 'container-removed', name: 'sidecar' });
  });
});

describe('memory runtime: down()', () => {
  it('removes every container and fires a removal event for each', async () => {
    const runtime = createMemoryRuntime();
    await runtime.apply(app([one, { name: 'sidecar', image: 'proxy:1' }]));

    const events: RuntimeEvent[] = [];
    runtime.subscribe((e) => {
      events.push(e);
    });
    await runtime.down();

    expect((await runtime.inspect()).containers.size).toBe(0);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === 'container-removed')).toBe(true);
  });

  it('is harmless when nothing was ever applied', async () => {
    const runtime = createMemoryRuntime();
    await expect(runtime.down()).resolves.toBeUndefined();
  });
});

describe('memory runtime: kill and markReady test hooks', () => {
  it('kill flips the container to exited and fires a container event', async () => {
    const runtime = createMemoryRuntime();
    await runtime.apply(app([one]));

    const events: RuntimeEvent[] = [];
    runtime.subscribe((e) => {
      events.push(e);
    });
    runtime.kill('api-0', { exitCode: 137 });

    const observed = (await runtime.inspect()).containers.get('api-0');
    expect(observed?.phase).toBe('exited');
    expect(observed?.exitCode).toBe(137);
    expect(events).toContainEqual({
      type: 'container',
      container: expect.objectContaining({ phase: 'exited', exitCode: 137 }),
    });
  });

  it('kill throws for a container that does not exist', () => {
    const runtime = createMemoryRuntime();
    expect(() => runtime.kill('ghost')).toThrow(/fiber-servo:/);
  });

  it('markReady flips one container and fires a container event', async () => {
    const runtime = createMemoryRuntime({ autoReady: false });
    const withProbe: ContainerSpec = { ...one, readiness: { exec: ['true'] } };
    await runtime.apply(app([withProbe]));

    const events: RuntimeEvent[] = [];
    runtime.subscribe((e) => {
      events.push(e);
    });
    runtime.markReady('api-0', true);

    expect((await runtime.inspect()).containers.get('api-0')?.ready).toBe(true);
    expect(events).toContainEqual({
      type: 'container',
      container: expect.objectContaining({ ready: true }),
    });
  });

  it('markReady throws for an unknown container', () => {
    const runtime = createMemoryRuntime();
    expect(() => runtime.markReady('ghost')).toThrow(/fiber-servo:/);
  });
});

describe('memory runtime: subscriptions', () => {
  it('supports multiple subscribers and a working unsubscribe', async () => {
    const runtime = createMemoryRuntime();
    const a: RuntimeEvent[] = [];
    const b: RuntimeEvent[] = [];
    const unsubA = runtime.subscribe((e) => {
      a.push(e);
    });
    runtime.subscribe((e) => {
      b.push(e);
    });

    await runtime.apply(app([one]));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    unsubA();
    await runtime.apply(app([])); // orphans `api-0`
    expect(a).toHaveLength(1); // unsubscribed: no second event
    expect(b).toHaveLength(2);
    expect(b[1]).toEqual({ type: 'container-removed', name: 'api-0' });
  });
});

describe('memory runtime: calls trace', () => {
  it('reads like a log a human would write', async () => {
    const runtime = createMemoryRuntime();
    await runtime.apply(app([one]));
    await runtime.apply(app([one])); // unchanged: skip
    runtime.kill('api-0');
    await runtime.apply(app([one])); // exited: restart
    await runtime.down();

    expect(runtime.calls).toEqual([
      'apply test services=1',
      'create api-0 image=app:1',
      'apply test services=1',
      'skip api-0 (unchanged)',
      'kill api-0',
      'apply test services=1',
      'restart api-0 image=app:1',
      'down',
    ]);
  });
});
