import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import {
  Container,
  Deployment,
  backoffDelay,
  collectOps,
  createDummyRuntime,
  createRoot,
  createStatusStore,
  formatOp,
  useContainerStatus,
  DEFAULT_RESTART_POLICY,
  type Op,
} from '../src/index.js';

const lines = (ops: readonly Op[]) => ops.map(formatOp);

function setup() {
  const sink = collectOps();
  const root = createRoot({ sink: sink.sink });
  return { root, sink };
}

/** Deliver a store event and commit the re-render it causes. */
function event(root: ReturnType<typeof createRoot>, id: string, state: 'running' | 'dead') {
  root.status.set(id, state);
  root.flush();
}

/** Let `ms` pass and commit whatever the timers scheduled. */
function elapse(root: ReturnType<typeof createRoot>, ms: number) {
  vi.advanceTimersByTime(ms);
  root.flush();
}

describe('phase 1: status store drives self-healing through the same op path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('status.set(id, "dead") produces START for that container only, after the base delay', () => {
    const { root, sink } = setup();
    root.render(
      <Deployment name="web" replicas={3}>
        <Container image="nginx" />
      </Deployment>,
    );
    sink.take();

    event(root, 'web-1', 'dead');
    expect(sink.ops).toEqual([]); // backoff first

    elapse(root, DEFAULT_RESTART_POLICY.baseDelayMs - 1);
    expect(sink.ops).toEqual([]);

    elapse(root, 1);
    expect(lines(sink.ops)).toEqual(['START container web-1 attempt=1']);
    expect(sink.ops[0]).toEqual({ type: 'START', kind: 'container', id: 'web-1', attempt: 1 });
    expect(root.liveIds()).toEqual(['web-0', 'web-1', 'web-2']);
  });

  it('a death is answered once: no second START until the store reports again', () => {
    const { root, sink } = setup();
    root.render(<Container name="c" image="app" restart={{ baseDelayMs: 10 }} />);
    sink.take();

    event(root, 'c', 'dead');
    elapse(root, 10);
    expect(lines(sink.ops)).toEqual(['START container c attempt=1']);

    elapse(root, 60_000);
    expect(sink.ops).toHaveLength(1);
  });

  it('a running report followed by another death is a new restart', () => {
    const { root, sink } = setup();
    root.render(<Container name="c" image="app" restart={{ baseDelayMs: 10 }} />);
    sink.take();

    event(root, 'c', 'dead');
    elapse(root, 10);
    event(root, 'c', 'running');
    event(root, 'c', 'dead');
    elapse(root, 20);

    expect(lines(sink.ops)).toEqual(['START container c attempt=1', 'START container c attempt=2']);
  });

  it('backoff grows by `factor` per consecutive restart and is capped by maxDelayMs', () => {
    const { root, sink } = setup();
    root.render(
      <Container name="c" image="app" restart={{ baseDelayMs: 100, factor: 2, maxDelayMs: 350 }} />,
    );
    sink.take();

    const delays: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      event(root, 'c', 'dead');
      const expected = Math.min(100 * 2 ** (attempt - 1), 350);
      delays.push(expected);
      elapse(root, expected - 1);
      expect(sink.ops, `attempt ${attempt} fired early`).toHaveLength(attempt - 1);
      elapse(root, 1);
      expect(lines(sink.ops).at(-1)).toBe(`START container c attempt=${attempt}`);
      event(root, 'c', 'running');
    }
    expect(delays).toEqual([100, 200, 350, 350]);
  });

  it('two deaths before the backoff fires still cause one START', () => {
    const { root, sink } = setup();
    root.render(<Container name="c" image="app" restart={{ baseDelayMs: 100 }} />);
    sink.take();

    event(root, 'c', 'dead');
    elapse(root, 50);
    event(root, 'c', 'dead'); // restarts the timer
    elapse(root, 99);
    expect(sink.ops).toEqual([]);
    elapse(root, 1);
    expect(lines(sink.ops)).toEqual(['START container c attempt=1']);
  });

  it('restart="never" leaves a dead container alone', () => {
    const { root, sink } = setup();
    root.render(<Container name="c" image="app" restart="never" />);
    sink.take();

    event(root, 'c', 'dead');
    elapse(root, 3_600_000);
    expect(sink.ops).toEqual([]);
  });

  it('maxRestarts stops the loop', () => {
    const { root, sink } = setup();
    root.render(<Container name="c" image="app" restart={{ baseDelayMs: 1, factor: 1, maxRestarts: 2 }} />);
    sink.take();

    for (let i = 0; i < 4; i++) {
      event(root, 'c', 'dead');
      elapse(root, 1);
    }
    expect(lines(sink.ops)).toEqual(['START container c attempt=1', 'START container c attempt=2']);
  });

  it('running for resetAfterMs resets the backoff', () => {
    const { root, sink } = setup();
    root.render(
      <Container name="c" image="app" restart={{ baseDelayMs: 100, factor: 2, resetAfterMs: 1_000 }} />,
    );
    sink.take();

    event(root, 'c', 'dead');
    elapse(root, 100); // attempt 1 after 100ms
    event(root, 'c', 'running');
    event(root, 'c', 'dead');
    elapse(root, 200); // attempt 2 after 200ms
    event(root, 'c', 'running');
    elapse(root, 1_000); // stable long enough
    event(root, 'c', 'dead');
    elapse(root, 100); // back to the base delay
    expect(lines(sink.ops)).toEqual([
      'START container c attempt=1',
      'START container c attempt=2',
      'START container c attempt=3',
    ]);
  });

  it('a restart timer is dropped when the container leaves the tree', () => {
    const { root, sink } = setup();
    const app = (replicas: number) => (
      <Deployment name="web" replicas={replicas}>
        <Container image="nginx" restart={{ baseDelayMs: 100 }} />
      </Deployment>
    );
    root.render(app(2));
    sink.take();

    event(root, 'web-1', 'dead');
    root.render(app(1));
    expect(lines(sink.ops)).toEqual(['DELETE container web-1']);
    sink.take();

    elapse(root, 1_000);
    expect(sink.ops).toEqual([]);
  });

  it('a spec change and a restart in the same commit emit UPDATE then START', () => {
    const { root, sink } = setup();
    const app = (image: string) => <Container name="c" image={image} restart={{ baseDelayMs: 100 }} />;
    root.render(app('app:1'));
    sink.take();

    event(root, 'c', 'dead'); // committed: the backoff timer is now armed
    vi.advanceTimersByTime(100); // timer fired: generation update queued, not yet committed
    root.render(app('app:2')); // one commit carries both

    expect(lines(sink.ops)).toEqual(['UPDATE container c changed=[image]', 'START container c attempt=1']);
    expect(lines(sink.batches.at(-1)!)).toEqual(lines(sink.ops)); // one commit, one batch
  });

  it('the dummy runtime closes the loop: START reports running, so the next death restarts again', () => {
    const store = createStatusStore();
    const printed: string[] = [];
    const root = createRoot({
      status: store,
      sink: createDummyRuntime({ log: (l) => printed.push(l), status: store }),
    });

    root.render(<Container name="c" image="app" restart={{ baseDelayMs: 10 }} />);
    expect(store.get('c').state).toBe('running');

    event(root, 'c', 'dead');
    elapse(root, 10);
    expect(store.get('c').state).toBe('running');
    event(root, 'c', 'dead');
    elapse(root, 20);

    expect(printed.filter((l) => l.includes('START'))).toEqual([
      '   START container c attempt=1',
      '   START container c attempt=2',
    ]);

    root.unmount();
    expect(store.get('c').state).toBe('unknown');
  });
});

describe('phase 1: reading status from user components', () => {
  it('useContainerStatus re-renders the tree when the store changes, without calling render()', async () => {
    vi.useRealTimers();
    const { root, sink } = setup();
    function Failover() {
      const primary = useContainerStatus('db-primary');
      return (
        <>
          <Container name="db-primary" image="postgres" restart="never" />
          {primary.state === 'dead' && <Container name="db-standby" image="postgres" />}
        </>
      );
    }
    root.render(<Failover />);
    sink.take();

    root.status.set('db-primary', 'dead');
    await Promise.resolve(); // the store event scheduled a sync re-render in a microtask

    expect(lines(sink.ops)).toEqual(['CREATE container db-standby image=postgres']);
  });

  it('backoffDelay is the documented formula', () => {
    const policy = { ...DEFAULT_RESTART_POLICY, baseDelayMs: 1000, factor: 2, maxDelayMs: 5000 };
    expect([0, 1, 2, 3, 10].map((n) => backoffDelay(n, policy))).toEqual([1000, 2000, 4000, 5000, 5000]);
  });
});
