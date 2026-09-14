import { describe, expect, it } from 'vitest';
import { digest, type ContainerSpec, type PodSpec } from '../src/resources.js';
import { createMemoryRuntime } from '../src/runtime/memory.js';
import type { RuntimeEvent } from '../src/runtime/types.js';

function pod(overrides: Partial<PodSpec> = {}): PodSpec {
  const containers: ContainerSpec[] = overrides.containers
    ? [...overrides.containers]
    : [{ name: 'app', image: 'app:1' }];
  return { name: 'api-0', containers, ...overrides };
}

describe('memory runtime: creating a Pod', () => {
  it('shows up in inspect() with its containers running', async () => {
    const runtime = createMemoryRuntime();
    await runtime.createPod(pod());

    const state = await runtime.inspect();
    const observed = state.pods.get('api-0');
    expect(observed).toBeDefined();
    expect(observed?.phase).toBe('running');
    expect(observed?.containers).toEqual([
      {
        name: 'app',
        id: 'api-0/app',
        phase: 'running',
        image: 'app:1',
        exitCode: undefined,
        ready: undefined,
      },
    ]);
    expect(observed?.specDigest).toBe(digest(pod()));
  });

  it('reports containers with a readiness probe as ready by default', async () => {
    const runtime = createMemoryRuntime();
    await runtime.createPod(
      pod({ containers: [{ name: 'app', image: 'app:1', readiness: { exec: ['true'] } }] }),
    );

    const state = await runtime.inspect();
    expect(state.pods.get('api-0')?.containers[0]?.ready).toBe(true);
  });

  it('autoStart: false leaves the Pod and its containers pending/waiting', async () => {
    const runtime = createMemoryRuntime({ autoStart: false });
    await runtime.createPod(pod());

    const state = await runtime.inspect();
    const observed = state.pods.get('api-0');
    expect(observed?.phase).toBe('pending');
    expect(observed?.containers[0]?.phase).toBe('waiting');
  });

  it('autoReady: false leaves a probed container not-ready even when running', async () => {
    const runtime = createMemoryRuntime({ autoReady: false });
    await runtime.createPod(
      pod({ containers: [{ name: 'app', image: 'app:1', readiness: { exec: ['true'] } }] }),
    );

    const state = await runtime.inspect();
    expect(state.pods.get('api-0')?.containers[0]?.ready).toBe(false);
  });

  it('is idempotent: creating the same spec twice is a no-op, not an error', async () => {
    const runtime = createMemoryRuntime();
    const spec = pod();
    await runtime.createPod(spec);
    const before = await runtime.inspect();

    await expect(runtime.createPod(spec)).resolves.toBeUndefined();

    const after = await runtime.inspect();
    expect(after.revision).toBe(before.revision);
    // `at` is the observation time and legitimately differs between two
    // `inspect()` calls even when nothing changed; compare everything else.
    const { at: _beforeAt, ...beforePod } = before.pods.get('api-0')!;
    const { at: _afterAt, ...afterPod } = after.pods.get('api-0')!;
    expect(afterPod).toEqual(beforePod);
  });

  it('recreates the Pod when the same name comes back with a different spec', async () => {
    const runtime = createMemoryRuntime();
    await runtime.createPod(pod());
    await runtime.createPod(pod({ containers: [{ name: 'app', image: 'app:2' }] }));

    const state = await runtime.inspect();
    expect(state.pods.get('api-0')?.containers[0]?.image).toBe('app:2');
  });
});

describe('memory runtime: removing a Pod', () => {
  it('removes it from inspect() and is idempotent for an unknown Pod', async () => {
    const runtime = createMemoryRuntime();
    await runtime.createPod(pod());

    await runtime.removePod('api-0');
    expect((await runtime.inspect()).pods.has('api-0')).toBe(false);

    // Second removal, and removal of a name that never existed: no-ops.
    await expect(runtime.removePod('api-0')).resolves.toBeUndefined();
    await expect(runtime.removePod('never-existed')).resolves.toBeUndefined();
  });
});

describe('memory runtime: containers', () => {
  it('createContainer adds one container without touching the others', async () => {
    const runtime = createMemoryRuntime();
    await runtime.createPod(pod());

    await runtime.createContainer('api-0', { name: 'sidecar', image: 'proxy:1' });

    const observed = (await runtime.inspect()).pods.get('api-0');
    expect(observed?.containers.map((c) => c.name).sort()).toEqual(['app', 'sidecar']);
    expect(observed?.containers.find((c) => c.name === 'app')?.phase).toBe('running');
  });

  it('createContainer is idempotent for a container that already exists', async () => {
    const runtime = createMemoryRuntime();
    await runtime.createPod(pod());
    await expect(runtime.createContainer('api-0', { name: 'app', image: 'app:1' })).resolves.toBeUndefined();
    expect((await runtime.inspect()).pods.get('api-0')?.containers).toHaveLength(1);
  });

  it('createContainer throws for a Pod that does not exist', async () => {
    const runtime = createMemoryRuntime();
    await expect(runtime.createContainer('ghost', { name: 'app', image: 'app:1' })).rejects.toThrow(
      /fiber-servo:/,
    );
  });

  it('removeContainer removes only the named container, and is idempotent', async () => {
    const runtime = createMemoryRuntime();
    await runtime.createPod(
      pod({
        containers: [
          { name: 'app', image: 'app:1' },
          { name: 'sidecar', image: 'p:1' },
        ],
      }),
    );

    await runtime.removeContainer('api-0', 'sidecar');
    const observed = (await runtime.inspect()).pods.get('api-0');
    expect(observed?.containers.map((c) => c.name)).toEqual(['app']);

    // Unknown container, and an unknown Pod: both no-ops, not errors.
    await expect(runtime.removeContainer('api-0', 'sidecar')).resolves.toBeUndefined();
    await expect(runtime.removeContainer('ghost', 'app')).resolves.toBeUndefined();
  });

  it('updateContainerResources changes resources without restarting anything', async () => {
    const runtime = createMemoryRuntime();
    await runtime.createPod(pod());
    const before = (await runtime.inspect()).pods.get('api-0')?.containers[0];

    await runtime.updateContainerResources('api-0', 'app', { cpu: 0.5, memory: '512m' });

    const after = (await runtime.inspect()).pods.get('api-0')?.containers[0];
    // Resources are not part of ObservedContainer -- nothing here is expected
    // to differ except that the runtime did not restart the container.
    expect(after).toEqual(before);
  });

  it('updateContainerResources throws for an unknown container', async () => {
    const runtime = createMemoryRuntime();
    await runtime.createPod(pod());
    await expect(runtime.updateContainerResources('api-0', 'ghost', { cpu: 1 })).rejects.toThrow(
      /fiber-servo:/,
    );
    await expect(runtime.updateContainerResources('ghost', 'app', { cpu: 1 })).rejects.toThrow(
      /fiber-servo:/,
    );
  });
});

describe('memory runtime: kill and markReady test hooks', () => {
  it('kill flips the Pod and its containers to exited and fires an event', async () => {
    const runtime = createMemoryRuntime();
    await runtime.createPod(pod());

    const events: RuntimeEvent[] = [];
    runtime.subscribe((e) => events.push(e));
    runtime.kill('api-0', { exitCode: 137 });

    const observed = (await runtime.inspect()).pods.get('api-0');
    expect(observed?.phase).toBe('exited');
    expect(observed?.containers[0]).toMatchObject({ phase: 'exited', exitCode: 137 });
    expect(events).toContainEqual({ type: 'pod', pod: expect.objectContaining({ phase: 'exited' }) });
  });

  it('kill throws for a Pod that does not exist', () => {
    const runtime = createMemoryRuntime();
    expect(() => runtime.kill('ghost')).toThrow(/fiber-servo:/);
  });

  it('markReady flips one container and fires a container event', async () => {
    const runtime = createMemoryRuntime({ autoReady: false });
    await runtime.createPod(
      pod({ containers: [{ name: 'app', image: 'app:1', readiness: { exec: ['true'] } }] }),
    );

    const events: RuntimeEvent[] = [];
    runtime.subscribe((e) => events.push(e));
    runtime.markReady('api-0', 'app', true);

    expect((await runtime.inspect()).pods.get('api-0')?.containers[0]?.ready).toBe(true);
    expect(events).toContainEqual({
      type: 'container',
      pod: 'api-0',
      container: expect.objectContaining({ ready: true }),
    });
  });

  it('markReady throws for an unknown container', () => {
    const runtime = createMemoryRuntime();
    expect(() => runtime.markReady('ghost', 'app')).toThrow(/fiber-servo:/);
  });
});

describe('memory runtime: subscriptions', () => {
  it('supports multiple subscribers and a working unsubscribe', async () => {
    const runtime = createMemoryRuntime();
    const a: RuntimeEvent[] = [];
    const b: RuntimeEvent[] = [];
    const unsubA = runtime.subscribe((e) => a.push(e));
    runtime.subscribe((e) => b.push(e));

    await runtime.createPod(pod());
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    unsubA();
    await runtime.removePod('api-0');
    expect(a).toHaveLength(1); // unsubscribed: no second event
    expect(b).toHaveLength(2);
    expect(b[1]).toEqual({ type: 'pod-removed', name: 'api-0' });
  });
});

describe('memory runtime: networks', () => {
  it('creates and removes networks, idempotently', async () => {
    const runtime = createMemoryRuntime();
    await runtime.createNetwork({ name: 'backend', subnet: '10.1.0.0/24' });
    expect((await runtime.inspect()).networks.get('backend')).toEqual({
      name: 'backend',
      subnet: '10.1.0.0/24',
    });

    await expect(runtime.createNetwork({ name: 'backend', subnet: '10.1.0.0/24' })).resolves.toBeUndefined();

    await runtime.removeNetwork('backend');
    expect((await runtime.inspect()).networks.has('backend')).toBe(false);
    await expect(runtime.removeNetwork('backend')).resolves.toBeUndefined();
    await expect(runtime.removeNetwork('never-existed')).resolves.toBeUndefined();
  });
});

describe('memory runtime: calls trace', () => {
  it('reads like a log a human would write', async () => {
    const runtime = createMemoryRuntime();
    await runtime.createPod(pod());
    await runtime.createContainer('api-0', { name: 'sidecar', image: 'proxy:1' });
    await runtime.updateContainerResources('api-0', 'app', { cpu: 0.5 });
    await runtime.removeContainer('api-0', 'sidecar');
    await runtime.removePod('api-0');

    expect(runtime.calls).toEqual([
      'createPod api-0',
      'createContainer api-0/sidecar image=proxy:1',
      'updateContainerResources api-0/app cpu=0.5',
      'removeContainer api-0/sidecar',
      'removePod api-0',
    ]);
  });
});
