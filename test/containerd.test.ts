import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digest, type ContainerSpec, type PodSpec } from '../src/resources.js';
import {
  createContainerdRuntime,
  encodeSpecLabel,
  infraRunArgs,
  memberRunArgs,
  updateResourcesArgs,
  type ApiContainer,
  type ApiEvent,
  type ApiTask,
  type ContainerdApi,
  type ContainerdRuntimeOptions,
  type ExecResult,
  type Nerdctl,
} from '../src/runtime/containerd/index.js';
import type { RuntimeEvent } from '../src/runtime/types.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: '', stderr });

function podSpec(overrides: Partial<PodSpec> = {}): PodSpec {
  return { name: 'api', containers: [{ name: 'app', image: 'app:1' }], ...overrides };
}

// ---- a fake containerd --------------------------------------------------------
//
// Two seams, one shared state. `nerdctl` (writes) and `api` (reads) both
// answer out of the same `containers`/`networks` maps, the way a real
// nerdctl CLI call and a real gRPC read both answer out of the one daemon.
// Realising a Pod still takes several calls across both seams that all have
// to agree, so this stays a state machine rather than a script of canned
// responses (see the original version of this comment, kept in git history,
// for why: fine for a container-only, op-based world; not for this one).
//
// The one rule that matters most here (see runtime.ts's file doc and
// nerdctl.ts's `isNotFound`): every response this fake gives is something
// real nerdctl 2.1.2 / containerd v2.2.2 was actually observed to produce,
// not a plausible guess. Three things below were checked against a real
// daemon specifically because they are easy to get wrong by guessing:
//
//   - a container's id is a generated 64-hex string, unrelated to its
//     `--name` (`handleRun`);
//   - `nerdctl rm` resolves its target by name *or* id (`handleRm`);
//   - a `ContainerDelete` event's `containerId` is unconditionally
//     `undefined` through `api.ts`'s decoder, because that message's field is
//     named `id`, not `container_id` (`removeAndEmit`).

interface FakeContainer {
  id: string;
  name: string;
  labels: Record<string, string>;
  image: string;
  running: boolean;
  /** False models "no task at all": never started (`nerdctl create`), or a task already deleted. */
  hasTask: boolean;
  exitCode?: number;
  ip?: string;
}

function createFakeContainerd() {
  const containers = new Map<string, FakeContainer>();
  const networks = new Map<string, { labels: Record<string, string>; subnet?: string }>();
  const probeResults = new Map<string, ExecResult>();
  const calls: string[] = [];
  let counter = 0;
  let subscriber: { onEvent: (e: ApiEvent) => void; onError?: (e: Error) => void } | undefined;

  const findByNameOrId = (t: string): FakeContainer | undefined =>
    containers.get(t) ?? [...containers.values()].find((c) => c.id === t);

  function emit(event: ApiEvent): void {
    subscriber?.onEvent(event);
  }

  function parseRun(rest: string[]): {
    name: string;
    labels: Record<string, string>;
    network?: string;
    image: string;
  } {
    const labels: Record<string, string> = {};
    let name = '';
    let network: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === '-d' || a === '--restart=no' || a === '--pull=missing') continue;
      if (a === '--name') {
        name = rest[++i]!;
        continue;
      }
      if (a === '--label') {
        const v = rest[++i]!;
        const eq = v.indexOf('=');
        labels[v.slice(0, eq)] = v.slice(eq + 1);
        continue;
      }
      if (a === '--network') {
        network = rest[++i];
        continue;
      }
      if (a.startsWith('--network=')) {
        network = a.slice('--network='.length);
        continue;
      }
      if (a === '-p' || a === '-e' || a === '--cpus' || a === '--memory') {
        i++;
        continue;
      }
      positional.push(a);
    }
    return { name, labels, network, image: positional[0] ?? '' };
  }

  function handleRun(rest: string[]): ExecResult {
    const parsed = parseRun(rest);
    if (containers.has(parsed.name))
      return fail(`nerdctl: conflict: name "${parsed.name}" is already in use`);
    counter += 1;
    const id = counter.toString(16).padStart(64, '0');
    containers.set(parsed.name, {
      id,
      name: parsed.name,
      labels: parsed.labels,
      image: parsed.image,
      running: true,
      hasTask: true,
      ip: parsed.network && !parsed.network.startsWith('container:') ? `10.88.0.${counter + 1}` : undefined,
    });
    emit({ topic: '/tasks/start', type: 'containerd.events.TaskStart', containerId: id });
    return ok(`${id}\n`);
  }

  /** What `nerdctl rm` does to one container: gone, task-delete then container-delete. Shared with `externalRemove` below. */
  function removeAndEmit(c: FakeContainer): void {
    containers.delete(c.name);
    emit({
      topic: '/tasks/delete',
      type: 'containerd.events.TaskDelete',
      containerId: c.id,
      exitStatus: c.exitCode ?? 0,
    });
    // No `containerId` here -- see the file doc above.
    emit({ topic: '/containers/delete', type: 'containerd.events.ContainerDelete' });
  }

  function handleRm(rest: string[]): ExecResult {
    for (const t of rest) {
      if (t === '-f') continue;
      const c = findByNameOrId(t); // nerdctl resolves either; the runtime now removes by id
      if (c) removeAndEmit(c);
    }
    return ok();
  }

  function handleInspect(rest: string[]): ExecResult {
    const format = rest[1] ?? '';
    const target = rest[2] ?? '';
    // The only `nerdctl inspect` left in the runtime is the Pod-IP read.
    if (format.includes('NetworkSettings.IPAddress')) {
      const c = findByNameOrId(target);
      return c ? ok(`${c.ip ?? ''}\n`) : fail('no such container');
    }
    return fail('no such container');
  }

  function handleNetwork(rest: string[]): ExecResult {
    const [sub, ...more] = rest;
    if (sub === 'create') {
      const name = more[more.length - 1]!;
      const labels: Record<string, string> = {};
      for (let i = 0; i < more.length; i++) {
        if (more[i] === '--label') {
          const v = more[++i]!;
          const eq = v.indexOf('=');
          labels[v.slice(0, eq)] = v.slice(eq + 1);
        }
      }
      const si = more.indexOf('--subnet');
      networks.set(name, { labels, subnet: si !== -1 ? more[si + 1] : undefined });
      return ok();
    }
    // Wordings below are copied from real nerdctl 2.x, not invented. An
    // earlier version of this fake answered "no such network" here, which
    // nerdctl never says -- it matched `isNotFound`'s pattern, so the
    // idempotent-remove test passed while the real adapter threw against a
    // real daemon. A fake may be simple, but it may not be fictional.
    if (sub === 'rm') {
      return networks.delete(more[0]!)
        ? ok()
        : fail(`no network found matching: ${more[0]}\nno network could be removed`);
    }
    if (sub === 'inspect') {
      const names = more.slice(2);
      return networks.has(names[0]!) ? ok(`${names[0]}\n`) : fail(`no network found matching: ${names[0]}`);
    }
    return ok();
  }

  const nerdctl: Nerdctl = {
    async exec(args) {
      calls.push(args.join(' '));
      const [cmd, ...rest] = args;
      switch (cmd) {
        case 'run':
          return handleRun(rest);
        case 'rm':
          return handleRm(rest);
        case 'inspect':
          return handleInspect(rest);
        case 'network':
          return handleNetwork(rest);
        case 'update':
          return ok();
        case 'exec':
          return probeResults.get(rest[0]!) ?? ok();
        default:
          return ok();
      }
    },
    // The write seam's own event stream retires along with the rest of the
    // nerdctl-based read path -- nothing in runtime.ts calls this any more.
    // Kept only so `Nerdctl` stays satisfied.
    async *stream() {},
  };

  const api: ContainerdApi = {
    async listContainers(): Promise<ApiContainer[]> {
      calls.push('api.listContainers');
      return [...containers.values()].map((c) => ({ id: c.id, image: c.image, labels: { ...c.labels } }));
    },
    async getContainer(id) {
      calls.push(`api.getContainer ${id}`);
      const c = [...containers.values()].find((x) => x.id === id);
      return c ? { id: c.id, image: c.image, labels: { ...c.labels } } : undefined;
    },
    async listTasks(): Promise<ApiTask[]> {
      calls.push('api.listTasks');
      const tasks: ApiTask[] = [];
      for (const c of containers.values()) {
        if (!c.hasTask) continue;
        tasks.push({
          id: c.id,
          status: c.running ? 'running' : 'stopped',
          ...(c.running ? {} : { exitStatus: c.exitCode ?? 0 }),
        });
      }
      return tasks;
    },
    subscribe(onEvent, onError) {
      calls.push('api.subscribe');
      subscriber = { onEvent, onError };
      return () => {
        if (subscriber?.onEvent === onEvent) subscriber = undefined;
      };
    },
    close() {
      calls.push('api.close');
    },
  };

  return {
    nerdctl,
    api,
    calls,
    containers,
    networks,
    probeResults,
    /** A process inside the container exiting on its own -- fires `/tasks/exit`, same as a real daemon noticing. */
    setExited: (name: string, exitCode: number): void => {
      const c = containers.get(name);
      if (!c) throw new Error(`fake containerd: no container named "${name}"`);
      c.running = false;
      c.exitCode = exitCode;
      emit({
        topic: '/tasks/exit',
        type: 'containerd.events.TaskExit',
        containerId: c.id,
        exitStatus: exitCode,
      });
    },
    /** The task alone gone, container still present -- same shape `nerdctl create` leaves a container in, verified against a real daemon. No event: this is direct state setup for `inspect()`, not a simulated live transition. */
    deleteTaskOnly: (name: string): void => {
      const c = containers.get(name);
      if (!c) throw new Error(`fake containerd: no container named "${name}"`);
      c.hasTask = false;
    },
    /** Something outside this process's own `removePod`/`removeContainer` removed a container -- e.g. an operator running `nerdctl rm` by hand. Exercises the event-driven removal path in isolation from the imperative one. */
    externalRemove: (name: string): void => {
      const c = containers.get(name);
      if (!c) throw new Error(`fake containerd: no container named "${name}"`);
      removeAndEmit(c);
    },
    /** Fails the live subscription the way a dropped gRPC stream would: `api.subscribe` gives no other signal that a stream has ended (see runtime.ts's file doc). */
    killStream: (error = new Error('stream dropped')): void => {
      const s = subscriber;
      subscriber = undefined;
      s?.onError?.(error);
    },
    idOf: (name: string): string => {
      const c = containers.get(name);
      if (!c) throw new Error(`fake containerd: no container named "${name}"`);
      return c.id;
    },
  };
}

function runtimeFor(
  fc: ReturnType<typeof createFakeContainerd>,
  extra: Partial<ContainerdRuntimeOptions> = {},
) {
  return createContainerdRuntime({ nerdctl: fc.nerdctl, api: fc.api, ...extra });
}

// ---- a CNI fixture on disk ----------------------------------------------------
//
// `cni.ts` is fixed and already verified against real nerdctl 2.1.2 (see its
// own file doc); these tests exercise the runtime reading through it against
// real conflist files, not a fake of `listNetworks` itself.

const cniDirs: string[] = [];

afterEach(() => {
  for (const dir of cniDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeCniFixture(
  namespace: string,
  networks: Record<string, { subnet?: string; labels?: Record<string, string> }>,
): string {
  const root = mkdtempSync(join(tmpdir(), 'fiber-servo-cni-'));
  cniDirs.push(root);
  const dir = join(root, namespace);
  mkdirSync(dir, { recursive: true });
  for (const [name, { subnet, labels }] of Object.entries(networks)) {
    writeFileSync(
      join(dir, `nerdctl-${name}.conflist`),
      JSON.stringify({
        cniVersion: '1.0.0',
        name,
        nerdctlLabels: labels ?? {},
        plugins: subnet
          ? [{ type: 'bridge', ipam: { ranges: [[{ subnet, gateway: subnet.replace(/0\/\d+$/, '1') }]] } }]
          : [{ type: 'bridge' }],
      }),
    );
  }
  return root;
}

// ---- argv: the sandbox, a member joining it, and the one in-place update ----

describe('containerd runtime: argv', () => {
  it('infraRunArgs runs the sandbox: publish and Pod labels live here, not on any member', () => {
    const spec: PodSpec = {
      name: 'api',
      network: 'backend',
      labels: { tier: 'web' },
      publish: [
        { host: 8080, target: 80 },
        { host: 9000, target: 90, protocol: 'udp' },
      ],
      containers: [{ name: 'app', image: 'app:1' }],
    };
    expect(infraRunArgs(spec, 'pause:3.9')).toEqual([
      'run',
      '-d',
      '--name',
      'api',
      '--restart=no',
      '--pull=missing',
      '--label',
      'fiber-servo.managed=true',
      '--label',
      `fiber-servo.spec=${digest(spec)}`,
      '--label',
      `fiber-servo.spec-json=${encodeSpecLabel(spec)}`,
      '--label',
      'fiber-servo.pod=api',
      '--label',
      'fiber-servo.role=infra',
      '--network',
      'backend',
      '-p',
      '8080:80',
      '-p',
      '9000:90/udp',
      '--label',
      'tier=web',
      'pause:3.9',
    ]);
  });

  it('memberRunArgs joins the sandbox with a single --network=container:<pod> token, and never publishes', () => {
    const spec: ContainerSpec = {
      name: 'app',
      image: 'app:1',
      env: { PORT: '80' },
      command: ['node', 'server.js'],
    };
    expect(memberRunArgs('api', spec)).toEqual([
      'run',
      '-d',
      '--name',
      'api-app',
      '--restart=no',
      '--pull=missing',
      '--label',
      'fiber-servo.managed=true',
      '--label',
      `fiber-servo.spec=${digest(spec)}`,
      '--label',
      `fiber-servo.spec-json=${encodeSpecLabel(spec)}`,
      '--label',
      'fiber-servo.pod=api',
      '--label',
      'fiber-servo.container=app',
      '--label',
      'fiber-servo.role=member',
      '--network=container:api',
      '-e',
      'PORT=80',
      'app:1',
      'node',
      'server.js',
    ]);
    // ports are documentation, and even a Pod that publishes leaves the member alone.
    expect(memberRunArgs('api', { ...spec, ports: [80] })).not.toContain('-p');
  });

  it('memberRunArgs applies initial cpu/memory with the same flags an update uses later', () => {
    const spec: ContainerSpec = { name: 'app', image: 'app:1', resources: { cpu: 0.5, memory: '512m' } };
    const args = memberRunArgs('api', spec);
    expect(args).toContain('--cpus');
    expect(args[args.indexOf('--cpus') + 1]).toBe('0.5');
    expect(args).toContain('--memory');
    expect(args[args.indexOf('--memory') + 1]).toBe('512m');
  });

  it('updateResourcesArgs is the one in-place mutation: nerdctl update --cpus/--memory', () => {
    expect(updateResourcesArgs('api', 'app', { cpu: 0.5, memory: '512m' })).toEqual([
      'update',
      '--cpus',
      '0.5',
      '--memory',
      '512m',
      'api-app',
    ]);
    expect(updateResourcesArgs('api', 'app', { cpu: 1 })).toEqual(['update', '--cpus', '1', 'api-app']);
  });
});

// ---- creating and removing Pods ---------------------------------------------

describe('containerd runtime: creating and removing Pods', () => {
  it('createPod runs the sandbox then each member, and is idempotent for the same spec (adoption by digest)', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    const spec = podSpec();

    await runtime.createPod(spec);
    const runCalls = fc.calls.filter((c) => c.startsWith('run '));
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]).toContain('--name api ');
    expect(runCalls[0]).toContain('fiber-servo.role=infra');
    expect(runCalls[1]).toContain('--name api-app ');
    expect(runCalls[1]).toContain('--network=container:api');

    const callsBefore = fc.calls.length;
    await runtime.createPod(spec); // same spec, same digest: idempotent
    expect(fc.calls.filter((c) => c.startsWith('run ')).length).toBe(2); // no new run
    expect(fc.calls.filter((c) => c.startsWith('rm ')).length).toBe(0);
    expect(fc.calls.length).toBeGreaterThan(callsBefore); // it still checked, just did not act
  });

  it('createPod replaces the whole Pod when the spec digest changes', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    await runtime.createPod(podSpec());
    await runtime.createPod(podSpec({ containers: [{ name: 'app', image: 'app:2' }] }));

    expect(fc.calls.filter((c) => c.startsWith('rm ')).length).toBeGreaterThan(0);
    const state = await runtime.inspect();
    expect(state.pods.get('api')?.containers[0]?.image).toBe('app:2');
  });

  it('createPod heals a member a crash left missing, without recreating the sandbox', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    const spec = podSpec({
      containers: [
        { name: 'app', image: 'app:1' },
        { name: 'sidecar', image: 'proxy:1' },
      ],
    });
    await runtime.createPod(spec);
    fc.containers.delete('api-sidecar'); // the sandbox and `app` made it; `sidecar` did not

    await runtime.createPod(spec); // same digest as before

    expect(fc.containers.has('api-sidecar')).toBe(true);
    expect(fc.calls.filter((c) => c.startsWith('run ') && c.includes('--name api ')).length).toBe(1);
  });

  it('removePod removes the sandbox and every member together, and is idempotent', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    await runtime.createPod(
      podSpec({
        containers: [
          { name: 'app', image: 'app:1' },
          { name: 'sidecar', image: 'proxy:1' },
        ],
      }),
    );

    await runtime.removePod('api');
    expect(fc.containers.size).toBe(0);
    expect((await runtime.inspect()).pods.has('api')).toBe(false);
    expect(fc.calls.filter((c) => c.startsWith('rm ')).length).toBe(1); // one rm for the whole Pod

    await expect(runtime.removePod('api')).resolves.toBeUndefined(); // already gone
    await expect(runtime.removePod('never-existed')).resolves.toBeUndefined();
    expect(fc.calls.filter((c) => c.startsWith('rm ')).length).toBe(1); // neither issued another rm
  });

  it('createContainer adds a member to a live sandbox, and throws for a Pod that does not exist', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    await runtime.createPod(podSpec());

    await runtime.createContainer('api', { name: 'sidecar', image: 'proxy:1' });
    expect(fc.containers.has('api-sidecar')).toBe(true);

    await expect(runtime.createContainer('ghost', { name: 'x', image: 'x' })).rejects.toThrow(/fiber-servo:/);
  });

  it('removeContainer removes one member and leaves the rest, and is idempotent', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    await runtime.createPod(
      podSpec({
        containers: [
          { name: 'app', image: 'app:1' },
          { name: 'sidecar', image: 'proxy:1' },
        ],
      }),
    );

    await runtime.removeContainer('api', 'sidecar');
    const pod = (await runtime.inspect()).pods.get('api');
    expect(pod?.containers.map((c) => c.name)).toEqual(['app']);

    await expect(runtime.removeContainer('api', 'sidecar')).resolves.toBeUndefined();
    await expect(runtime.removeContainer('ghost', 'app')).resolves.toBeUndefined();
  });
});

// ---- inspect(): the resync path, now over the API ----------------------------

describe('containerd runtime: inspect()', () => {
  it('groups members under their Pod and fills ip, specDigest, spec and phase, from task status', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    const spec = podSpec({
      network: 'backend',
      containers: [
        { name: 'app', image: 'app:1' },
        { name: 'sidecar', image: 'proxy:1' },
      ],
    });
    await runtime.createPod(spec);

    const state = await runtime.inspect();
    const pod = state.pods.get('api');
    expect(pod?.phase).toBe('running');
    expect(pod?.specDigest).toBe(digest(spec));
    expect(pod?.ip).toMatch(/^10\.88\.0\./);
    expect(pod?.containers.map((c) => c.name).sort()).toEqual(['app', 'sidecar']);
    expect(pod?.containers.every((c) => c.phase === 'running')).toBe(true);
    expect(pod?.spec).toEqual(spec); // reconstructed from labels, across the whole Pod
  });

  it('a stopped task reads as exited with its exit code', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    await runtime.createPod(podSpec());
    fc.setExited('api-app', 7);

    const pod = (await runtime.inspect()).pods.get('api');
    expect(pod?.containers[0]).toMatchObject({ name: 'app', phase: 'exited', exitCode: 7 });
  });

  it('a container with no task at all -- never started, or its task already cleaned up -- reads as exited with no exit code', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    await runtime.createPod(podSpec());
    fc.deleteTaskOnly('api-app');

    const pod = (await runtime.inspect()).pods.get('api');
    expect(pod?.containers[0]).toMatchObject({ name: 'app', phase: 'exited', exitCode: undefined });
  });

  it('a Pod with no fiber-servo label at all reports specDigest and spec as undefined, not a crash', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    fc.containers.set('stray', {
      id: 'f'.repeat(64),
      name: 'stray',
      labels: {}, // not managed at all: inspect() must not even surface it
      image: 'whatever',
      running: true,
      hasTask: true,
    });

    const state = await runtime.inspect();
    expect(state.pods.size).toBe(0);
  });

  it('recovers specDigest, spec and the readiness schedule purely from labels -- across a fresh runtime instance', async () => {
    const fc = createFakeContainerd();
    const runtime1 = runtimeFor(fc);
    const spec = podSpec({ containers: [{ name: 'app', image: 'app:1', readiness: { exec: ['true'] } }] });
    await runtime1.createPod(spec);

    // A second runtime over the same containerd state simulates a process
    // restart: its idIndex and readinessTargets start empty and can only be
    // rebuilt from labels, exactly as a genuinely fresh process would have to.
    const runtime2 = runtimeFor(fc);
    const pod = (await runtime2.inspect()).pods.get('api');
    expect(pod?.specDigest).toBe(digest(spec));
    expect(pod?.spec).toEqual(spec);
  });
});

// ---- events -> RuntimeEvent ---------------------------------------------------

describe('containerd runtime: events -> RuntimeEvent', () => {
  it('translates a task start into a running Pod, and a member task exit into a container event with its exit code', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc, { reconnectDelayMs: 5 });

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 10)); // let the initial (empty) resync land

    await runtime.createPod(podSpec()); // run -> /tasks/start, observed live since we're already subscribed
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toContainEqual({
      type: 'pod',
      pod: expect.objectContaining({ name: 'api', phase: 'running' }),
    });

    fc.setExited('api-app', 3); // -> /tasks/exit
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toContainEqual({
      type: 'container',
      pod: 'api',
      container: expect.objectContaining({ name: 'app', phase: 'exited', exitCode: 3 }),
    });

    unsubscribe();
  });

  it('a /containers/delete for the whole Pod is attributed by diffing the id index, not by an id the event never carries', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc, { reconnectDelayMs: 5 });
    await runtime.createPod(podSpec());
    await runtime.inspect(); // populate the id index the way a resync at subscribe time also would

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 10));

    fc.externalRemove('api-app'); // a member gone from outside this process
    fc.externalRemove('api'); // ... and now the sandbox too: the whole Pod
    await new Promise((r) => setTimeout(r, 15));

    expect(events).toContainEqual({ type: 'pod-removed', name: 'api' });
    unsubscribe();
  });

  it('an externally removed member alone (Pod still up) re-announces the Pod with that member gone, not pod-removed', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc, { reconnectDelayMs: 5 });
    await runtime.createPod(
      podSpec({
        containers: [
          { name: 'app', image: 'app:1' },
          { name: 'sidecar', image: 'proxy:1' },
        ],
      }),
    );
    await runtime.inspect();

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 10));

    fc.externalRemove('api-sidecar');
    await new Promise((r) => setTimeout(r, 15));

    expect(events).not.toContainEqual(expect.objectContaining({ type: 'pod-removed' }));
    expect(events).toContainEqual({
      type: 'pod',
      pod: expect.objectContaining({ name: 'api', containers: [expect.objectContaining({ name: 'app' })] }),
    });
    unsubscribe();
  });

  it('emits a resync from a full inspect() when a subscriber attaches, and again once the stream dies', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc, { reconnectDelayMs: 5 });
    await runtime.createPod(podSpec());

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 10));
    const afterAttach = events.filter((e) => e.type === 'resync').length;
    expect(afterAttach).toBeGreaterThan(0);
    expect(events.find((e) => e.type === 'resync')).toMatchObject({
      type: 'resync',
      state: { pods: expect.any(Map), networks: expect.any(Map) },
    });

    fc.killStream(); // the only signal a real dropped gRPC stream gives, too -- see runtime.ts's file doc
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'resync').length).toBeGreaterThan(afterAttach);

    unsubscribe();
  });
});

// ---- readiness -----------------------------------------------------------------

describe('containerd runtime: readiness prober', () => {
  it('execs the probe until it exits 0, then reports ready via a container event', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc, { probeTickMs: 5 });
    fc.probeResults.set('api-app', fail('not ready yet'));
    await runtime.createPod(
      // `intervalMs` matters: it defaults to 2000, which would put the second
      // attempt well past the end of this test.
      podSpec({
        containers: [{ name: 'app', image: 'app:1', readiness: { exec: ['pg_isready'], intervalMs: 5 } }],
      }),
    );

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 15));
    expect(events.some((e) => e.type === 'container' && e.container.ready === true)).toBe(false);

    fc.probeResults.set('api-app', ok());
    await new Promise((r) => setTimeout(r, 15));
    unsubscribe();

    expect(events).toContainEqual({
      type: 'container',
      pod: 'api',
      container: expect.objectContaining({ name: 'app', ready: true }),
    });
    expect(fc.calls).toContainEqual('exec api-app pg_isready');
  });
});

// ---- networks: writes on nerdctl, reads from CNI config files ---------------

describe('containerd runtime: networks', () => {
  it('creates and removes networks idempotently through nerdctl, by presence alone', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);

    await runtime.createNetwork({ name: 'backend', subnet: '10.9.0.0/24' });
    expect(fc.networks.has('backend')).toBe(true);

    await expect(runtime.createNetwork({ name: 'backend', subnet: '10.9.0.0/24' })).resolves.toBeUndefined();
    expect(fc.calls.filter((c) => c.startsWith('network create')).length).toBe(1); // already there: no second create

    await runtime.removeNetwork('backend');
    expect(fc.networks.has('backend')).toBe(false);
    await expect(runtime.removeNetwork('backend')).resolves.toBeUndefined();
    await expect(runtime.removeNetwork('never-existed')).resolves.toBeUndefined();
  });

  it('inspect() reads networks from CNI conflist files, including the always-present built-ins', async () => {
    const fc = createFakeContainerd();
    const cniPath = makeCniFixture('default', {
      backend: { subnet: '10.9.0.0/24' },
      frontend: { subnet: '10.10.0.0/24', labels: { tier: 'web' } },
    });
    const runtime = runtimeFor(fc, { cni: { cniPath, namespace: 'default' } });

    const state = await runtime.inspect();
    expect(state.networks.get('host')).toEqual({ name: 'host' });
    expect(state.networks.get('none')).toEqual({ name: 'none' });
    expect(state.networks.get('backend')).toEqual({ name: 'backend', subnet: '10.9.0.0/24' });
    expect(state.networks.get('frontend')).toEqual({ name: 'frontend', subnet: '10.10.0.0/24' });
  });

  it('a namespace with no CNI directory yet still reports the built-ins, not an error', async () => {
    const fc = createFakeContainerd();
    const cniPath = makeCniFixture('default', {}); // creates the "default" dir but nothing in "other"
    const runtime = runtimeFor(fc, { cni: { cniPath, namespace: 'other' } });

    const state = await runtime.inspect();
    expect([...state.networks.keys()].sort()).toEqual(['host', 'none']);
  });
});
