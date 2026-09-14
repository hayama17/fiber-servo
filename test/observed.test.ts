import { describe, expect, it, vi } from 'vitest';
import { applyRuntimeEvent, createObservedStore, isReady } from '../src/observed.js';
import type { ObservedContainer } from '../src/runtime/types.js';

function container(overrides: Partial<ObservedContainer> = {}): ObservedContainer {
  return {
    name: 'app',
    phase: 'waiting',
    networks: [],
    labels: {},
    at: 1,
    ...overrides,
  };
}

/** The common case in these tests: a container that has come up. */
function running(overrides: Partial<ObservedContainer> = {}): ObservedContainer {
  return container({ phase: 'running', ...overrides });
}

describe('createObservedStore', () => {
  it('keeps the same snapshot identity until something changes, and a new one after', () => {
    const store = createObservedStore();
    const first = store.snapshot();
    expect(store.snapshot()).toBe(first);

    store.set(running());
    const second = store.snapshot();
    expect(second).not.toBe(first);
    expect(store.snapshot()).toBe(second);
  });

  it('bumps revision on every mutation', () => {
    const store = createObservedStore();
    expect(store.snapshot().revision).toBe(0);
    store.set(running());
    expect(store.snapshot().revision).toBe(1);
    store.set(running({ name: 'other' }));
    expect(store.snapshot().revision).toBe(2);
  });

  it('freezes the containers it hands out', () => {
    const store = createObservedStore();
    store.set(running({ labels: { app: 'web' } }));
    const observed = store.get('app')!;
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.labels)).toBe(true);
    expect(Object.isFrozen(observed.networks)).toBe(true);
  });

  it('patch on an unknown container is a no-op', () => {
    const store = createObservedStore();
    const before = store.snapshot();
    store.patch('ghost', { phase: 'running' });
    expect(store.snapshot()).toBe(before);
    expect(store.get('ghost')).toBeUndefined();
  });

  it('patch merges into a known container, keeping fields not mentioned', () => {
    const store = createObservedStore();
    store.set(container({ phase: 'waiting', image: 'app:1' }));
    store.patch('app', { phase: 'running' });
    const observed = store.get('app')!;
    expect(observed.phase).toBe('running');
    expect(observed.image).toBe('app:1'); // untouched field survives the merge
  });

  it('set replaces wholesale rather than merging', () => {
    const store = createObservedStore();
    store.set(running({ image: 'app:1', networks: ['backend'] }));
    store.set(running()); // no image, no networks this time
    const observed = store.get('app')!;
    expect(observed.image).toBeUndefined();
    expect(observed.networks).toEqual([]);
  });

  it('remove forgets the container, and is a no-op when already gone', () => {
    const store = createObservedStore();
    store.set(running());
    const revBefore = store.snapshot().revision;

    store.remove('app');
    expect(store.get('app')).toBeUndefined();
    expect(store.snapshot().revision).toBe(revBefore + 1);

    const revAfter = store.snapshot().revision;
    store.remove('app'); // already gone
    expect(store.snapshot().revision).toBe(revAfter);
  });

  it('reset replaces the whole store; absent containers are gone', () => {
    const store = createObservedStore();
    store.set(running({ name: 'app' }));
    store.set(running({ name: 'worker' }));

    store.reset([running({ name: 'app', image: 'app:2' })]);

    expect(store.get('app')?.image).toBe('app:2');
    expect(store.get('worker')).toBeUndefined();
    expect(store.snapshot().containers.size).toBe(1);
  });

  it('notifies subscribers synchronously, and stops after unsubscribe', () => {
    const store = createObservedStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);

    store.set(running());
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    store.set(running({ phase: 'exited' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('isReady', () => {
  it('is false for an undefined container', () => {
    expect(isReady(undefined)).toBe(false);
  });

  it('is false when the container is not running, even if ready was set', () => {
    expect(isReady(container({ phase: 'waiting', ready: true }))).toBe(false);
  });

  it('is true when running and ready is not explicitly false', () => {
    expect(isReady(running({ ready: true }))).toBe(true);
  });

  it('is true when running and readiness was never reported at all (no probe)', () => {
    expect(isReady(running({ ready: undefined }))).toBe(true);
  });

  it('is false when running but explicitly reported unready', () => {
    expect(isReady(running({ ready: false }))).toBe(false);
  });
});

describe('applyRuntimeEvent', () => {
  it('handles a "container" event via set', () => {
    const store = createObservedStore();
    applyRuntimeEvent(store, { type: 'container', container: running({ image: 'app:1' }) });
    expect(store.get('app')?.image).toBe('app:1');
  });

  it('handles a "container-removed" event', () => {
    const store = createObservedStore();
    store.set(running());
    applyRuntimeEvent(store, { type: 'container-removed', name: 'app' });
    expect(store.get('app')).toBeUndefined();
  });

  it('handles a "resync" event via reset', () => {
    const store = createObservedStore();
    store.set(running({ name: 'stale' }));
    applyRuntimeEvent(store, { type: 'resync', containers: [running({ name: 'app' })] });
    expect(store.get('stale')).toBeUndefined();
    expect(store.get('app')).toBeDefined();
  });
});
