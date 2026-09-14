import { describe, expect, it, vi } from 'vitest';
import { applyRuntimeEvent, createObservedStore, derivePodPhase, isPodReady } from '../src/observed.js';
import type { ObservedContainer, ObservedPod } from '../src/runtime/types.js';

function pod(overrides: Partial<ObservedPod> = {}): ObservedPod {
  return {
    name: 'api',
    phase: 'pending',
    labels: {},
    containers: [],
    at: 1,
    ...overrides,
  };
}

function container(overrides: Partial<ObservedContainer> = {}): ObservedContainer {
  return { name: 'app', phase: 'running', ...overrides };
}

describe('createObservedStore', () => {
  it('keeps the same snapshot identity until something changes, and a new one after', () => {
    const store = createObservedStore();
    const first = store.snapshot();
    expect(store.snapshot()).toBe(first);

    store.setPod(pod());
    const second = store.snapshot();
    expect(second).not.toBe(first);
    expect(store.snapshot()).toBe(second);
  });

  it('bumps revision on every mutation', () => {
    const store = createObservedStore();
    expect(store.snapshot().revision).toBe(0);
    store.setPod(pod());
    expect(store.snapshot().revision).toBe(1);
    store.setNetwork({ name: 'backend' });
    expect(store.snapshot().revision).toBe(2);
  });

  it('freezes the pods it hands out', () => {
    const store = createObservedStore();
    store.setPod(pod());
    const observed = store.getPod('api')!;
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.labels)).toBe(true);
    expect(Object.isFrozen(observed.containers)).toBe(true);
  });

  it('patchPod on an unknown Pod is a no-op', () => {
    const store = createObservedStore();
    const before = store.snapshot();
    store.patchPod('ghost', { ip: '10.0.0.5' });
    expect(store.snapshot()).toBe(before);
    expect(store.getPod('ghost')).toBeUndefined();
  });

  it('patchPod merges into a known Pod, keeping fields not mentioned', () => {
    const store = createObservedStore();
    store.setPod(pod({ ip: '10.0.0.1' }));
    store.patchPod('api', { phase: 'running' });
    const observed = store.getPod('api')!;
    expect(observed.phase).toBe('running');
    expect(observed.ip).toBe('10.0.0.1'); // untouched field survives the merge
  });

  it('setPod replaces wholesale rather than merging', () => {
    const store = createObservedStore();
    store.setPod(pod({ ip: '10.0.0.1', containers: [container()] }));
    store.setPod(pod()); // no ip, no containers this time
    const observed = store.getPod('api')!;
    expect(observed.ip).toBeUndefined();
    expect(observed.containers).toEqual([]);
  });

  it('patchContainer no-ops for an unknown Pod', () => {
    const store = createObservedStore();
    const before = store.snapshot();
    store.patchContainer('ghost', 'app', { phase: 'running' });
    expect(store.snapshot()).toBe(before);
  });

  it('patchContainer adds a container to a known Pod that does not list it yet', () => {
    const store = createObservedStore();
    store.setPod(pod()); // sandbox observed, no containers yet
    store.patchContainer('api', 'app', { phase: 'waiting' });
    const observed = store.getPod('api')!;
    expect(observed.containers).toHaveLength(1);
    expect(observed.containers[0]).toMatchObject({ name: 'app', phase: 'waiting' });
  });

  it('patchContainer merges into an existing container, keeping fields not mentioned', () => {
    const store = createObservedStore();
    store.setPod(pod({ containers: [container({ phase: 'waiting', image: 'api:v1' })] }));
    store.patchContainer('api', 'app', { phase: 'running' });
    const observed = store.getPod('api')!;
    expect(observed.containers[0]).toMatchObject({ phase: 'running', image: 'api:v1' });
  });

  it('patchContainer re-derives the Pod phase from the container list', () => {
    const store = createObservedStore();
    store.setPod(pod({ phase: 'pending', containers: [container({ phase: 'waiting' })] }));
    store.patchContainer('api', 'app', { phase: 'running' });
    expect(store.getPod('api')!.phase).toBe('running');
  });

  it('an explicit phase from patchPod stands only until the next container observation', () => {
    const store = createObservedStore();
    store.setPod(pod({ phase: 'running', containers: [container({ phase: 'running' })] }));
    store.patchPod('api', { phase: 'exited' }); // adapter asserts the sandbox is gone
    expect(store.getPod('api')!.phase).toBe('exited');
    store.patchContainer('api', 'app', { phase: 'running' }); // fresh container info
    expect(store.getPod('api')!.phase).toBe('running'); // re-derived, superseding the explicit value
  });

  it('reset replaces pods and networks wholesale; absent pods are gone', () => {
    const store = createObservedStore();
    store.setPod(pod({ name: 'api' }));
    store.setPod(pod({ name: 'worker' }));
    store.setNetwork({ name: 'backend' });

    store.reset({
      pods: new Map([['api', pod({ name: 'api', phase: 'running' })]]),
      networks: new Map(),
    });

    expect(store.getPod('api')?.phase).toBe('running');
    expect(store.getPod('worker')).toBeUndefined();
    expect(store.snapshot().networks.size).toBe(0);
  });

  it('removePod and removeNetwork forget the resource, and are no-ops when already gone', () => {
    const store = createObservedStore();
    store.setPod(pod());
    store.setNetwork({ name: 'backend' });
    const revBefore = store.snapshot().revision;

    store.removePod('api');
    store.removeNetwork('backend');
    expect(store.getPod('api')).toBeUndefined();
    expect(store.snapshot().networks.has('backend')).toBe(false);
    expect(store.snapshot().revision).toBe(revBefore + 2);

    const revAfter = store.snapshot().revision;
    store.removePod('api'); // already gone
    expect(store.snapshot().revision).toBe(revAfter);
  });

  it('notifies subscribers synchronously, and stops after unsubscribe', () => {
    const store = createObservedStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);

    store.setPod(pod());
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    store.setPod(pod({ phase: 'running' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('derivePodPhase', () => {
  it('is pending for an empty container list', () => {
    expect(derivePodPhase([])).toBe('pending');
  });

  it('is running when every container is running', () => {
    expect(
      derivePodPhase([container({ phase: 'running' }), container({ name: 'sidecar', phase: 'running' })]),
    ).toBe('running');
  });

  it('is exited when there are containers and none of them is running', () => {
    expect(derivePodPhase([container({ phase: 'exited' })])).toBe('exited');
  });

  it('is pending for a mix of phases', () => {
    expect(
      derivePodPhase([container({ phase: 'running' }), container({ name: 'sidecar', phase: 'waiting' })]),
    ).toBe('pending');
  });
});

describe('isPodReady', () => {
  it('is false for an undefined Pod', () => {
    expect(isPodReady(undefined)).toBe(false);
  });

  it('is false when the Pod is not running, even with ready containers', () => {
    expect(isPodReady(pod({ phase: 'pending', containers: [container({ ready: true })] }))).toBe(false);
  });

  it('is true when running and no container reports unready', () => {
    expect(isPodReady(pod({ phase: 'running', containers: [container({ ready: true })] }))).toBe(true);
  });

  it('is true when running and a container never reports readiness at all (no probe)', () => {
    expect(isPodReady(pod({ phase: 'running', containers: [container({ ready: undefined })] }))).toBe(true);
  });

  it('is false when any container explicitly reports unready', () => {
    const containers = [
      container({ name: 'app', ready: true }),
      container({ name: 'sidecar', ready: false }),
    ];
    expect(isPodReady(pod({ phase: 'running', containers }))).toBe(false);
  });
});

describe('applyRuntimeEvent', () => {
  it('handles a "pod" event via setPod', () => {
    const store = createObservedStore();
    applyRuntimeEvent(store, { type: 'pod', pod: pod({ ip: '10.0.0.9' }) });
    expect(store.getPod('api')?.ip).toBe('10.0.0.9');
  });

  it('handles a "pod-removed" event', () => {
    const store = createObservedStore();
    store.setPod(pod());
    applyRuntimeEvent(store, { type: 'pod-removed', name: 'api' });
    expect(store.getPod('api')).toBeUndefined();
  });

  it('handles a "container" event via patchContainer', () => {
    const store = createObservedStore();
    store.setPod(pod());
    applyRuntimeEvent(store, {
      type: 'container',
      pod: 'api',
      container: container({ phase: 'running', ready: true }),
    });
    const observed = store.getPod('api')!;
    expect(observed.containers[0]).toMatchObject({ name: 'app', phase: 'running', ready: true });
    expect(observed.phase).toBe('running'); // re-derived
  });

  it('handles a "resync" event via reset', () => {
    const store = createObservedStore();
    store.setPod(pod({ name: 'stale' }));
    applyRuntimeEvent(store, {
      type: 'resync',
      state: { pods: new Map([['api', pod({ name: 'api' })]]), networks: new Map() },
    });
    expect(store.getPod('stale')).toBeUndefined();
    expect(store.getPod('api')).toBeDefined();
  });
});
