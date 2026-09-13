import { describe, expect, it, vi } from 'vitest';
import { UNKNOWN_STATUS, createStatusStore } from '../src/index.js';

describe('status store', () => {
  it('returns the shared unknown snapshot for ids it has never seen', () => {
    const store = createStatusStore();
    expect(store.get('nope')).toBe(UNKNOWN_STATUS);
    expect(store.get('nope')).toBe(store.get('other'));
  });

  it('every set is an event: seq advances even when the state repeats', () => {
    const store = createStatusStore(() => 42);
    const a = store.set('c', 'dead', { exitCode: 137 });
    const b = store.set('c', 'dead');
    expect(a).toEqual({ state: 'dead', seq: 1, at: 42, exitCode: 137 });
    expect(b).toEqual({ state: 'dead', seq: 2, at: 42 });
    expect(a).not.toBe(b);
    expect(store.get('c')).toBe(b);
  });

  it('snapshots are stable between events and frozen', () => {
    const store = createStatusStore();
    store.set('c', 'running');
    expect(store.get('c')).toBe(store.get('c'));
    expect(Object.isFrozen(store.get('c'))).toBe(true);
  });

  it('notifies subscribers on set and remove, and stops after unsubscribe', () => {
    const store = createStatusStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);

    store.set('c', 'running');
    store.remove('c');
    store.remove('c'); // already gone: no event
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get('c')).toBe(UNKNOWN_STATUS);

    off();
    store.set('c', 'dead');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('lists every recorded id', () => {
    const store = createStatusStore();
    store.set('a', 'running');
    store.set('b', 'dead');
    expect([...store.entries().keys()]).toEqual(['a', 'b']);
  });
});
