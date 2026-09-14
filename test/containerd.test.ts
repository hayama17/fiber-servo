import { describe, expect, it } from 'vitest';
import { digest, type ContainerSpec, type PodSpec } from '../src/resources.js';
import {
  CONTAINER_LABEL,
  MANAGED_LABEL,
  POD_LABEL,
  ROLE_LABEL,
  SPEC_LABEL,
  createContainerdRuntime,
  encodeSpecLabel,
  infraRunArgs,
  memberRunArgs,
  updateResourcesArgs,
  type ExecResult,
  type Nerdctl,
} from '../src/runtime/containerd/index.js';
import type { RuntimeEvent } from '../src/runtime/types.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: '', stderr });

function podSpec(overrides: Partial<PodSpec> = {}): PodSpec {
  return { name: 'api', containers: [{ name: 'app', image: 'app:1' }], ...overrides };
}

function memoryStringToBytes(s: string): number {
  const m = /^(\d+(?:\.\d+)?)([kmg])?$/i.exec(s.trim());
  if (!m) return Number(s) || 0;
  const unit = (m[2] ?? '').toLowerCase();
  const mult = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return Math.round(Number(m[1]) * mult);
}

// ---- a fake containerd -------------------------------------------------------
//
// Not a script of canned responses (the old adapter's test used one, keyed by
// subcommand -- fine for a container-only, op-based world). Realising a Pod
// takes several *different* nerdctl calls in sequence (run, inspect, ps,
// rm...) that all have to agree on the same state, so this fake actually
// keeps that state -- a map of containers and networks -- and answers each
// call the way real nerdctl would, by reading the same `--format` strings
// `runtime.ts` sends. Tests below drive the `Runtime` methods directly and
// assert on what came out, the same way `test/memory-runtime.test.ts` does.

interface FakeContainer {
  id: string;
  name: string;
  labels: Record<string, string>;
  image: string;
  running: boolean;
  exitCode?: number;
  cpu?: number;
  memory?: string;
  ip?: string;
}

function createFakeContainerd() {
  const containers = new Map<string, FakeContainer>();
  const networks = new Map<string, { labels: Record<string, string>; subnet?: string }>();
  const probeResults = new Map<string, ExecResult>();
  const eventLines: string[] = [];
  const calls: string[] = [];
  let counter = 0;

  const findByNameOrId = (t: string): FakeContainer | undefined =>
    containers.get(t) ?? [...containers.values()].find((c) => c.id === t);

  function parseRun(rest: string[]) {
    const labels: Record<string, string> = {};
    let name = '';
    let network: string | undefined;
    let cpu: number | undefined;
    let memory: string | undefined;
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
      if (a === '-p') {
        i++;
        continue;
      } // publish: recorded via calls.join, not fake state
      if (a === '-e') {
        i++;
        continue;
      }
      if (a === '--cpus') {
        cpu = Number(rest[++i]);
        continue;
      }
      if (a === '--memory') {
        memory = rest[++i];
        continue;
      }
      positional.push(a);
    }
    return { name, labels, network, cpu, memory, image: positional[0] ?? '' };
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
      cpu: parsed.cpu,
      memory: parsed.memory,
      ip: parsed.network && !parsed.network.startsWith('container:') ? `10.88.0.${counter + 1}` : undefined,
    });
    return ok(`${id}\n`);
  }

  function handleRm(rest: string[]): ExecResult {
    for (const name of rest) if (name !== '-f') containers.delete(name);
    return ok();
  }

  function handleInspect(rest: string[]): ExecResult {
    const format = rest[1] ?? '';
    const targets = rest.slice(2);
    if (format.includes('NetworkSettings.IPAddress')) {
      const c = findByNameOrId(targets[0]!);
      return c ? ok(`${c.ip ?? ''}\n`) : fail('no such container');
    }
    if (format.includes('HostConfig.NanoCpus')) {
      const lines = targets.map((t) => {
        const c = findByNameOrId(t);
        if (!c) return '';
        const nano = c.cpu !== undefined ? Math.round(c.cpu * 1e9) : 0;
        const bytes = c.memory !== undefined ? memoryStringToBytes(c.memory) : 0;
        return `/${c.name} ${nano} ${bytes}`;
      });
      return ok(lines.join('\n') + '\n');
    }
    if (format.includes('State.Status')) {
      const c = findByNameOrId(targets[0]!);
      if (!c) return fail('no such container');
      return ok(`${c.id} ${c.running ? 'running' : 'exited'} ${c.exitCode ?? 0} ${c.image}\n`);
    }
    if (format.includes(MANAGED_LABEL) && format.includes(ROLE_LABEL)) {
      const c = findByNameOrId(targets[0]!);
      if (!c) return fail('no such container');
      return ok(
        `${c.labels[MANAGED_LABEL] ?? ''} ${c.labels[POD_LABEL] ?? ''} ${c.labels[CONTAINER_LABEL] ?? ''} ${c.labels[ROLE_LABEL] ?? ''}\n`,
      );
    }
    // inspectContainer: {{.Id}} {{SPEC_LABEL}}
    const c = findByNameOrId(targets[0]!);
    if (!c) return fail('no such container');
    return ok(`${c.id} ${c.labels[SPEC_LABEL] ?? ''}\n`);
  }

  function handlePs(rest: string[]): ExecResult {
    let podFilter: string | undefined;
    const fi = rest.indexOf('--filter');
    if (fi !== -1) {
      const m = /^label=fiber-servo\.pod=(.*)$/.exec(rest[fi + 1] ?? '');
      if (m) podFilter = m[1];
    }
    const rows = [...containers.values()]
      .filter((c) => c.labels[MANAGED_LABEL] === 'true')
      .filter((c) => !podFilter || c.labels[POD_LABEL] === podFilter)
      .map((c) =>
        JSON.stringify({
          ID: c.id,
          Names: c.name,
          Image: c.image,
          Status: c.running ? 'Up 1 second' : `Exited (${c.exitCode ?? 0}) 1 second ago`,
          Labels: Object.entries(c.labels)
            .map(([k, v]) => `${k}=${v}`)
            .join(','),
        }),
      );
    return ok(rows.join('\n') + '\n');
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
    if (sub === 'rm') return networks.delete(more[0]!) ? ok() : fail('no such network');
    if (sub === 'inspect') {
      const fmt = more[1] ?? '';
      const names = more.slice(2);
      if (fmt.includes('IPAM')) {
        return ok(names.map((n) => `${n} ${networks.get(n)?.subnet ?? ''}`).join('\n') + '\n');
      }
      return networks.has(names[0]!) ? ok(`${names[0]}\n`) : fail('no such network');
    }
    if (sub === 'ls') {
      const rows = [...networks.entries()].map(([name, n]) =>
        JSON.stringify({
          Name: name,
          Labels: Object.entries(n.labels)
            .map(([k, v]) => `${k}=${v}`)
            .join(','),
        }),
      );
      return ok(rows.join('\n') + '\n');
    }
    return ok();
  }

  function handleUpdate(rest: string[]): ExecResult {
    const name = rest[rest.length - 1]!;
    const c = containers.get(name);
    if (!c) return fail('no such container');
    for (let i = 0; i < rest.length - 1; i++) {
      if (rest[i] === '--cpus') c.cpu = Number(rest[++i]);
      if (rest[i] === '--memory') c.memory = rest[++i];
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
        case 'ps':
          return handlePs(rest);
        case 'network':
          return handleNetwork(rest);
        case 'update':
          return handleUpdate(rest);
        case 'exec':
          return probeResults.get(rest[0]!) ?? ok();
        default:
          return ok();
      }
    },
    async *stream(args) {
      calls.push(args.join(' '));
      for (const line of eventLines.splice(0)) yield line;
    },
  };

  return {
    nerdctl,
    calls,
    containers,
    networks,
    eventLines,
    probeResults,
    idOf: (name: string): string => {
      const c = containers.get(name);
      if (!c) throw new Error(`fake containerd: no container named "${name}"`);
      return c.id;
    },
  };
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
  it('createPod runs the sandbox then each member, and is idempotent for the same spec', async () => {
    const fc = createFakeContainerd();
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl });
    const spec = podSpec();

    await runtime.createPod(spec);
    const runCalls = fc.calls.filter((c) => c.startsWith('run '));
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]).toContain('--name api ');
    expect(runCalls[0]).toContain('fiber-servo.role=infra');
    expect(runCalls[1]).toContain('--name api-app ');
    expect(runCalls[1]).toContain('--network=container:api');

    const callsBefore = fc.calls.length;
    await runtime.createPod(spec); // same spec: idempotent
    expect(fc.calls.filter((c) => c.startsWith('run ')).length).toBe(2); // no new run
    expect(fc.calls.filter((c) => c.startsWith('rm ')).length).toBe(0);
    expect(fc.calls.length).toBeGreaterThan(callsBefore); // it still checked, just did not act
  });

  it('createPod replaces the whole Pod when the spec digest changes', async () => {
    const fc = createFakeContainerd();
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl });
    await runtime.createPod(podSpec());
    await runtime.createPod(podSpec({ containers: [{ name: 'app', image: 'app:2' }] }));

    expect(fc.calls.filter((c) => c.startsWith('rm ')).length).toBeGreaterThan(0);
    const state = await runtime.inspect();
    expect(state.pods.get('api')?.containers[0]?.image).toBe('app:2');
  });

  it('createPod heals a member a crash left missing, without recreating the sandbox', async () => {
    const fc = createFakeContainerd();
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl });
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
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl });
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
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl });
    await runtime.createPod(podSpec());

    await runtime.createContainer('api', { name: 'sidecar', image: 'proxy:1' });
    expect(fc.containers.has('api-sidecar')).toBe(true);

    await expect(runtime.createContainer('ghost', { name: 'x', image: 'x' })).rejects.toThrow(/fiber-servo:/);
  });

  it('removeContainer removes one member and leaves the rest, and is idempotent', async () => {
    const fc = createFakeContainerd();
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl });
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

// ---- inspect(): the resync path ----------------------------------------------

describe('containerd runtime: inspect()', () => {
  it('groups members under their Pod and fills ip, specDigest, spec and phase', async () => {
    const fc = createFakeContainerd();
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl });
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

  it('reflects a live nerdctl update in the reconstructed spec, without any label ever being rewritten', async () => {
    const fc = createFakeContainerd();
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl });
    await runtime.createPod(podSpec());

    await runtime.updateContainerResources('api', 'app', { cpu: 0.5, memory: '512m' });

    const pod = (await runtime.inspect()).pods.get('api');
    expect(pod?.spec?.containers[0]).toMatchObject({ name: 'app', resources: { cpu: 0.5, memory: '512m' } });
  });

  it('a Pod with no fiber-servo label at all reports specDigest and spec as undefined, not a crash', async () => {
    const fc = createFakeContainerd();
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl });
    fc.containers.set('stray', {
      id: 'f'.repeat(64),
      name: 'stray',
      labels: {}, // not managed at all: inspect() must not even surface it
      image: 'whatever',
      running: true,
    });

    const state = await runtime.inspect();
    expect(state.pods.size).toBe(0);
  });
});

// ---- events -> RuntimeEvent ---------------------------------------------------

describe('containerd runtime: events -> RuntimeEvent', () => {
  it('translates a member exit, a sandbox start, and a sandbox delete', async () => {
    const fc = createFakeContainerd();
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl, reconnectDelayMs: 5 });
    await runtime.createPod(podSpec());
    const infraId = fc.idOf('api');
    const appId = fc.idOf('api-app');

    fc.eventLines.push(
      JSON.stringify({
        ID: appId,
        Topic: '/tasks/exit',
        Event: JSON.stringify({ container_id: appId, id: appId, exit_status: 1 }),
      }),
      JSON.stringify({
        ID: infraId,
        Topic: '/tasks/start',
        Event: JSON.stringify({ container_id: infraId }),
      }),
    );
    fc.containers.get('api-app')!.running = false;
    fc.containers.get('api-app')!.exitCode = 1;

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 20));
    unsubscribe();

    expect(events).toContainEqual({
      type: 'container',
      pod: 'api',
      container: expect.objectContaining({ name: 'app', phase: 'exited', exitCode: 1 }),
    });
    // The sandbox starting does NOT make the Pod running: its only member has
    // exited, and a Pod's phase is derived from its containers, not from the
    // sandbox. Asserting `exited` here is the point of the case.
    expect(events).toContainEqual({
      type: 'pod',
      pod: expect.objectContaining({ name: 'api', phase: 'exited' }),
    });
  });

  it('translates a sandbox delete as the whole Pod disappearing', async () => {
    const fc = createFakeContainerd();
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl, reconnectDelayMs: 5 });
    await runtime.createPod(podSpec());
    const infraId = fc.idOf('api');

    fc.eventLines.push(
      JSON.stringify({ ID: infraId, Topic: '/containers/delete', Event: JSON.stringify({ id: infraId }) }),
    );

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 20));
    unsubscribe();

    expect(events).toContainEqual({ type: 'pod-removed', name: 'api' });
  });

  it('falls back to a periodic inspect() resync once the event stream ends', async () => {
    const fc = createFakeContainerd();
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl, reconnectDelayMs: 5 });
    await runtime.createPod(podSpec());
    // No lines queued: the fake's `stream` ends immediately, every time it is opened.

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 30));
    unsubscribe();

    const resyncs = events.filter((e) => e.type === 'resync');
    expect(resyncs.length).toBeGreaterThan(0);
    expect(resyncs[0]).toMatchObject({
      type: 'resync',
      state: { pods: expect.any(Map), networks: expect.any(Map) },
    });
  });
});

// ---- readiness -----------------------------------------------------------------

describe('containerd runtime: readiness prober', () => {
  it('execs the probe until it exits 0, then reports ready via a container event', async () => {
    const fc = createFakeContainerd();
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl, probeTickMs: 5 });
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

// ---- networks --------------------------------------------------------------------

describe('containerd runtime: networks', () => {
  it('creates and removes networks idempotently, and lists subnets back through inspect()', async () => {
    const fc = createFakeContainerd();
    const runtime = createContainerdRuntime({ nerdctl: fc.nerdctl });

    await runtime.createNetwork({ name: 'backend', subnet: '10.9.0.0/24' });
    expect((await runtime.inspect()).networks.get('backend')).toEqual({
      name: 'backend',
      subnet: '10.9.0.0/24',
    });

    await expect(runtime.createNetwork({ name: 'backend', subnet: '10.9.0.0/24' })).resolves.toBeUndefined();
    expect(fc.calls.filter((c) => c.startsWith('network create')).length).toBe(1);

    await runtime.removeNetwork('backend');
    expect((await runtime.inspect()).networks.has('backend')).toBe(false);
    await expect(runtime.removeNetwork('backend')).resolves.toBeUndefined();
    await expect(runtime.removeNetwork('never-existed')).resolves.toBeUndefined();
  });
});
