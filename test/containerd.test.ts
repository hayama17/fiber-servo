import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerSpec, NetworkSpec, ReadinessProbe } from '../src/resources.js';
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  MANAGED_LABEL,
  NERDCTL_NETWORKS_LABEL,
  READINESS_LABEL,
  SPEC_LABEL,
  encodeReadiness,
  toComposeApplication,
  type ComposeApplication,
} from '../src/compose.js';
import {
  createContainerdRuntime,
  type ApiContainer,
  type ApiEvent,
  type ApiTask,
  type ContainerdApi,
  type ContainerdRuntimeOptions,
  type ExecResult,
  type Nerdctl,
} from '../src/runtime/containerd/index.js';
import type { RuntimeEvent } from '../src/runtime/types.js';

const PROJECT = 'fiber-servo';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: '', stderr });

/** Build a `ComposeApplication` the same way the control plane does -- through `compose.ts`, not by hand. */
function model(containers: ContainerSpec[], networks: NetworkSpec[] = []): ComposeApplication {
  return toComposeApplication(containers, networks, PROJECT);
}

/** Attach `READINESS_LABEL` to one service's labels -- for a model built by hand rather than from a spec carrying a probe. */
function withReadiness(app: ComposeApplication, service: string, probe: ReadinessProbe): ComposeApplication {
  const target = app.services[service];
  if (!target) throw new Error(`no service "${service}" in this model`);
  return {
    ...app,
    services: {
      ...app.services,
      [service]: { ...target, labels: { ...target.labels, [READINESS_LABEL]: encodeReadiness(probe) } },
    },
  };
}

// ---- a fake containerd --------------------------------------------------------
//
// One seam apiece, one shared state -- `nerdctl` (writes) and `api` (reads)
// both answer out of the same `containers` map, the way a real nerdctl CLI
// call and a real gRPC read both answer out of the one daemon.
//
// The one rule that matters most here: every response this fake gives is
// something real nerdctl 2.1.2 / containerd v2.2.2 was actually observed to
// produce, checked live against a real daemon, not a plausible guess. Three
// things below exist specifically because they are easy to get wrong by
// guessing:
//
//   - `compose rm -f -s <service>` fails outright with "no such service: x"
//     when `x` is not a key in the file loaded with `-f` -- it does not fall
//     back to finding the container by label (`handleRm`). This is why
//     `apply()` in runtime.ts writes removal stubs for orphaned services
//     before removing them.
//   - `compose up -d --no-recreate` on an already-running, unchanged service
//     does nothing at all -- no new task event, no new id (`handleUp`).
//   - a `ContainerDelete` event's `containerId` is unconditionally
//     `undefined` through `api.ts`'s decoder (`removeAndEmit`), because that
//     message's field is named `id`, not `container_id`.

interface FakeContainer {
  id: string;
  service: string;
  labels: Record<string, string>;
  image: string;
  running: boolean;
  /** False models "no task at all": never started, or a task already deleted. */
  hasTask: boolean;
  exitCode?: number;
}

function createFakeContainerd(project = PROJECT) {
  const containers = new Map<string, FakeContainer>(); // keyed by service name -- one instance per service, index 1
  const probeResults = new Map<string, ExecResult>();
  const calls: string[] = [];
  let counter = 0;
  let subscriber: { onEvent: (e: ApiEvent) => void; onError?: (e: Error) => void } | undefined;

  function emit(event: ApiEvent): void {
    subscriber?.onEvent(event);
  }

  function readModel(file: string): ComposeApplication {
    return JSON.parse(readFileSync(file, 'utf8')) as ComposeApplication;
  }

  function removeAndEmit(c: FakeContainer): void {
    containers.delete(c.service);
    emit({
      topic: '/tasks/delete',
      type: 'containerd.events.TaskDelete',
      containerId: c.id,
      exitStatus: c.exitCode ?? 0,
    });
    // No `containerId` here -- see the file doc above.
    emit({ topic: '/containers/delete', type: 'containerd.events.ContainerDelete' });
  }

  function handleUp(file: string): ExecResult {
    const app = readModel(file);
    if (app.name !== project) return ok(); // a different project's file: nothing here to do
    for (const [service, def] of Object.entries(app.services)) {
      const existing = containers.get(service);
      if (!existing) {
        counter += 1;
        const id = counter.toString(16).padStart(64, '0');
        containers.set(service, {
          id,
          service,
          labels: {
            [COMPOSE_PROJECT_LABEL]: app.name,
            [COMPOSE_SERVICE_LABEL]: service,
            [NERDCTL_NETWORKS_LABEL]: JSON.stringify(def.networks ?? []),
            ...def.labels,
          },
          image: def.image,
          running: true,
          hasTask: true,
        });
        emit({ topic: '/tasks/start', type: 'containerd.events.TaskStart', containerId: id });
      } else if (!existing.running) {
        // `--no-recreate` means exactly what it says: an existing, merely
        // stopped container is *started*, not replaced. Same id, fresh task.
        existing.running = true;
        existing.hasTask = true;
        existing.exitCode = undefined;
        emit({ topic: '/tasks/start', type: 'containerd.events.TaskStart', containerId: existing.id });
      }
      // else: already running and unchanged -- `--no-recreate` does nothing,
      // and does not even emit an event, matching what a real daemon does
      // when `nerdctl start` meets an already-running container.
    }
    return ok();
  }

  function handleRm(file: string, rest: string[]): ExecResult {
    const app = readModel(file);
    const sIndex = rest.indexOf('-s');
    const services = rest.slice(sIndex + 1);
    // Verified live: `rm -s <service>` validates every name against the keys
    // declared in the *loaded file*, not against what is actually running.
    for (const service of services) {
      if (!(service in app.services)) return fail(`no such service: ${service}`);
    }
    for (const service of services) {
      const existing = containers.get(service);
      if (existing) removeAndEmit(existing); // absent is a silent no-op, verified live
    }
    return ok();
  }

  function handleDown(file: string): ExecResult {
    let app: ComposeApplication;
    try {
      app = readModel(file);
    } catch {
      return fail(`open ${file}: no such file or directory`);
    }
    if (app.name !== project) return ok();
    for (const c of [...containers.values()]) removeAndEmit(c);
    return ok();
  }

  function handleExec(rest: string[]): ExecResult {
    const service = rest[0] ?? '';
    return probeResults.get(service) ?? ok();
  }

  const nerdctl: Nerdctl = {
    async exec(args) {
      calls.push(args.join(' '));
      if (args[0] !== 'compose') return ok();
      const [, , file, verb, ...rest] = args;
      switch (verb) {
        case 'up':
          return handleUp(file!);
        case 'rm':
          return handleRm(file!, rest);
        case 'down':
          return handleDown(file!);
        case 'exec':
          return handleExec(rest);
        default:
          return ok();
      }
    },
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
    probeResults,
    /** A process inside the container exiting on its own -- fires `/tasks/exit`. */
    setExited: (service: string, exitCode: number): void => {
      const c = containers.get(service);
      if (!c) throw new Error(`fake containerd: no service "${service}"`);
      c.running = false;
      c.exitCode = exitCode;
      emit({
        topic: '/tasks/exit',
        type: 'containerd.events.TaskExit',
        containerId: c.id,
        exitStatus: exitCode,
      });
    },
    /** Something outside this process removed a container -- e.g. an operator running `nerdctl rm` by hand. */
    externalRemove: (service: string): void => {
      const c = containers.get(service);
      if (!c) throw new Error(`fake containerd: no service "${service}"`);
      removeAndEmit(c);
    },
    /** Fails the live subscription the way a dropped gRPC stream would -- `api.subscribe`'s only such signal. */
    killStream: (error = new Error('stream dropped')): void => {
      const s = subscriber;
      subscriber = undefined;
      s?.onError?.(error);
    },
    idOf: (service: string): string => {
      const c = containers.get(service);
      if (!c) throw new Error(`fake containerd: no service "${service}"`);
      return c.id;
    },
  };
}

// ---- a stable compose file per test ------------------------------------------

const composeDirs: string[] = [];

afterEach(() => {
  for (const dir of composeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempComposeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fiber-servo-compose-'));
  composeDirs.push(dir);
  return join(dir, 'compose.json');
}

function runtimeFor(
  fc: ReturnType<typeof createFakeContainerd>,
  extra: Partial<ContainerdRuntimeOptions> = {},
) {
  return createContainerdRuntime({
    nerdctl: fc.nerdctl,
    api: fc.api,
    project: PROJECT,
    composeFile: tempComposeFile(),
    ...extra,
  });
}

// ---- apply(): the two-step write path ----------------------------------------

describe('containerd runtime: apply()', () => {
  it('a fresh apply renders the file and runs exactly `compose -f <file> up -d --no-recreate`, no rm', async () => {
    const fc = createFakeContainerd();
    const composeFile = tempComposeFile();
    const runtime = runtimeFor(fc, { composeFile });

    await runtime.apply(model([{ name: 'app', image: 'app:1' }]));

    expect(fc.calls.filter((c) => c.startsWith('compose'))).toEqual([
      `compose -f ${composeFile} up -d --no-recreate`,
    ]);
    expect(fc.containers.has('app')).toBe(true);
    expect(JSON.parse(readFileSync(composeFile, 'utf8'))).toEqual(model([{ name: 'app', image: 'app:1' }]));
  });

  it('is idempotent for an unchanged model: `up` runs again, but nothing is removed or recreated', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    const spec = model([{ name: 'app', image: 'app:1' }]);

    await runtime.apply(spec);
    const idBefore = fc.idOf('app');

    fc.calls.length = 0;
    await runtime.apply(spec); // same model, same digest

    expect(fc.calls.filter((c) => c.startsWith('compose'))).toHaveLength(1); // `up` only, no `rm`
    expect(fc.calls.some((c) => c.includes(' rm '))).toBe(false);
    expect(fc.idOf('app')).toBe(idBefore); // not recreated
  });

  it('self-heals a killed container through `up --no-recreate` alone, without an rm', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    const spec = model([{ name: 'app', image: 'app:1' }]);
    await runtime.apply(spec);
    const idBefore = fc.idOf('app');

    fc.setExited('app', 137); // killed from outside

    fc.calls.length = 0;
    await runtime.apply(spec); // same model: the runtime never even sees a "changed" service

    expect(fc.calls.some((c) => c.includes(' rm '))).toBe(false);
    expect(fc.idOf('app')).toBe(idBefore); // same container, just restarted
    const state = await runtime.inspect();
    expect(state.containers.get('app')?.phase).toBe('running');
  });

  it('a changed service is removed with `rm -f -s <service>` before `up` recreates it, siblings untouched', async () => {
    const fc = createFakeContainerd();
    const composeFile = tempComposeFile();
    const runtime = runtimeFor(fc, { composeFile });
    await runtime.apply(
      model([
        { name: 'app', image: 'app:1' },
        { name: 'sidecar', image: 'proxy:1' },
      ]),
    );
    const sidecarId = fc.idOf('sidecar');
    const appIdBefore = fc.idOf('app');

    fc.calls.length = 0;
    await runtime.apply(
      model([
        { name: 'app', image: 'app:2' },
        { name: 'sidecar', image: 'proxy:1' },
      ]),
    );

    expect(fc.calls.filter((c) => c.startsWith('compose'))).toEqual([
      `compose -f ${composeFile} rm -f -s app`,
      `compose -f ${composeFile} up -d --no-recreate`,
    ]);
    expect(fc.idOf('app')).not.toBe(appIdBefore); // replaced
    expect(fc.idOf('sidecar')).toBe(sidecarId); // untouched
    expect(fc.containers.get('app')?.image).toBe('app:2');
  });

  it('a service the model no longer declares is removed via the same `compose rm`, with a stub so the removal file still names it', async () => {
    const fc = createFakeContainerd();
    const composeFile = tempComposeFile();
    const runtime = runtimeFor(fc, { composeFile });
    await runtime.apply(
      model([
        { name: 'app', image: 'app:1' },
        { name: 'sidecar', image: 'proxy:1' },
      ]),
    );

    fc.calls.length = 0;
    const finalModel = model([{ name: 'app', image: 'app:1' }]); // sidecar dropped
    await runtime.apply(finalModel);

    expect(fc.calls.filter((c) => c.startsWith('compose'))).toEqual([
      `compose -f ${composeFile} rm -f -s sidecar`,
      `compose -f ${composeFile} up -d --no-recreate`,
    ]);
    expect(fc.containers.has('sidecar')).toBe(false);
    expect(fc.containers.has('app')).toBe(true);
    // The file on disk ends up exactly the final model -- the removal stub
    // that made `rm` accept "sidecar" does not survive into what `up` sees.
    expect(JSON.parse(readFileSync(composeFile, 'utf8'))).toEqual(finalModel);
  });

  it('a changed service and an orphaned one are removed together in one sorted `rm -f -s`', async () => {
    const fc = createFakeContainerd();
    const composeFile = tempComposeFile();
    const runtime = runtimeFor(fc, { composeFile });
    await runtime.apply(
      model([
        { name: 'web', image: 'web:1' },
        { name: 'app', image: 'app:1' },
        { name: 'sidecar', image: 'proxy:1' },
      ]),
    );

    fc.calls.length = 0;
    await runtime.apply(
      model([
        { name: 'web', image: 'web:1' },
        { name: 'app', image: 'app:2' },
      ]),
    ); // app changed, sidecar dropped

    expect(fc.calls.filter((c) => c.startsWith('compose'))).toEqual([
      `compose -f ${composeFile} rm -f -s app sidecar`, // sorted
      `compose -f ${composeFile} up -d --no-recreate`,
    ]);
  });

  it('down() runs exactly `compose -f <file> down` and removes everything', async () => {
    const fc = createFakeContainerd();
    const composeFile = tempComposeFile();
    const runtime = runtimeFor(fc, { composeFile });
    await runtime.apply(model([{ name: 'app', image: 'app:1' }]));

    fc.calls.length = 0;
    await runtime.down();

    expect(fc.calls.filter((c) => c.startsWith('compose'))).toEqual([`compose -f ${composeFile} down`]);
    expect(fc.containers.size).toBe(0);
    expect((await runtime.inspect()).containers.size).toBe(0);
  });

  it('down() is a no-op, issuing no nerdctl call at all, when apply() was never called', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);

    await expect(runtime.down()).resolves.toBeUndefined();
    expect(fc.calls.filter((c) => c.startsWith('compose'))).toHaveLength(0);
  });
});

// ---- inspect(): grouping by Compose's own labels ------------------------------

describe('containerd runtime: inspect()', () => {
  it('groups by com.docker.compose.service and fills image, networks, specDigest and phase', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    const spec = model([{ name: 'app', image: 'app:1', network: 'backend' }], [{ name: 'backend' }]);
    await runtime.apply(spec);

    const state = await runtime.inspect();
    const app = state.containers.get('app');
    expect(app?.phase).toBe('running');
    expect(app?.image).toBe('app:1');
    expect(app?.networks).toEqual(['backend']);
    expect(app?.specDigest).toBe(spec.services['app']!.labels![SPEC_LABEL]);
    expect(app?.labels[MANAGED_LABEL]).toBe('true');
    expect(app?.labels[COMPOSE_PROJECT_LABEL]).toBe(PROJECT);
  });

  it('a stopped task reads as exited with its exit code', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    await runtime.apply(model([{ name: 'app', image: 'app:1' }]));
    fc.setExited('app', 7);

    const state = await runtime.inspect();
    expect(state.containers.get('app')).toMatchObject({ phase: 'exited', exitCode: 7 });
  });

  it('a container from a different project (or with no compose labels at all) is not surfaced', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    await runtime.apply(model([{ name: 'app', image: 'app:1' }]));
    fc.containers.set('stray', {
      id: 'f'.repeat(64),
      service: 'stray',
      labels: { [COMPOSE_PROJECT_LABEL]: 'someone-elses-project', [COMPOSE_SERVICE_LABEL]: 'stray' },
      image: 'whatever',
      running: true,
      hasTask: true,
    });

    const state = await runtime.inspect();
    expect(state.containers.has('stray')).toBe(false);
    expect(state.containers.size).toBe(1);
  });

  it('recovers specDigest across a fresh runtime instance -- purely from labels, no state carried over', async () => {
    const fc = createFakeContainerd();
    const composeFile = tempComposeFile();
    const runtime1 = createContainerdRuntime({
      nerdctl: fc.nerdctl,
      api: fc.api,
      project: PROJECT,
      composeFile,
    });
    const spec = model([{ name: 'app', image: 'app:1' }]);
    await runtime1.apply(spec);

    // A second runtime over the same containerd state simulates a process
    // restart: its idIndex starts empty and can only be rebuilt from labels.
    const runtime2 = createContainerdRuntime({
      nerdctl: fc.nerdctl,
      api: fc.api,
      project: PROJECT,
      composeFile,
    });
    const state = await runtime2.inspect();
    expect(state.containers.get('app')?.specDigest).toBe(spec.services['app']!.labels![SPEC_LABEL]);
  });

  // `compose up` on a file with no services is a hard error, not a no-op --
  // and an empty application is exactly what the last pass of `stop()` asks
  // for. Removing everything must not then fail on the way out.
  it('applies an empty model by removing what is there, without calling `up` on nothing', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    await runtime.apply(model([{ name: 'app', image: 'app:1' }]));
    fc.calls.length = 0;

    await runtime.apply(model([]));

    const nerdctlCalls = fc.calls.filter((c) => !c.startsWith('api.'));
    expect(nerdctlCalls.some((c) => c.includes('rm -f -s app'))).toBe(true);
    expect(nerdctlCalls.some((c) => c.includes('up'))).toBe(false);
    expect((await runtime.inspect()).containers.size).toBe(0);
  });

  // A model for one project applied by an adapter reading another is the
  // failure with no symptom: every inspect() filters for a project nothing
  // was created under, so the plan reports the whole application missing on
  // every pass and the loop reapplies it for ever, silently.
  it('refuses a model whose project is not the one it reads back, rather than looping for ever', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc);
    const foreign = toComposeApplication([{ name: 'app', image: 'app:1' }], [], 'somebody-elses-project');
    await expect(runtime.apply(foreign)).rejects.toThrow(
      /reads project "fiber-servo".*"somebody-elses-project"/s,
    );
    expect(fc.calls).toEqual([]); // and it never touched the machine
  });
});

// ---- events -> RuntimeEvent ---------------------------------------------------

describe('containerd runtime: events -> RuntimeEvent', () => {
  it('translates a task start into a running container, and a task exit into an exited one with its exit code', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc, { reconnectDelayMs: 5 });

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => void events.push(e));
    await new Promise((r) => setTimeout(r, 10)); // let the initial (empty) resync land

    await runtime.apply(model([{ name: 'app', image: 'app:1' }])); // -> /tasks/start, observed live since we're already subscribed
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toContainEqual({
      type: 'container',
      container: expect.objectContaining({ name: 'app', phase: 'running' }),
    });

    fc.setExited('app', 3); // -> /tasks/exit
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toContainEqual({
      type: 'container',
      container: expect.objectContaining({ name: 'app', phase: 'exited', exitCode: 3 }),
    });

    unsubscribe();
  });

  it('a /containers/delete is attributed by diffing the id index, not by an id the event never carries', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc, { reconnectDelayMs: 5 });
    await runtime.apply(model([{ name: 'app', image: 'app:1' }]));
    await runtime.inspect(); // populate the id index the way a resync at subscribe time also would

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => void events.push(e));
    await new Promise((r) => setTimeout(r, 10));

    fc.externalRemove('app'); // e.g. an operator running `nerdctl rm` by hand
    await new Promise((r) => setTimeout(r, 15));

    expect(events).toContainEqual({ type: 'container-removed', name: 'app' });
    unsubscribe();
  });

  it('emits a resync from a full inspect() when a subscriber attaches, and again once the stream dies', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc, { reconnectDelayMs: 5 });
    await runtime.apply(model([{ name: 'app', image: 'app:1' }]));

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => void events.push(e));
    await new Promise((r) => setTimeout(r, 10));
    const afterAttach = events.filter((e) => e.type === 'resync').length;
    expect(afterAttach).toBeGreaterThan(0);
    expect(events.find((e) => e.type === 'resync')).toMatchObject({
      type: 'resync',
      containers: expect.any(Array),
    });

    fc.killStream(); // the only signal a real dropped gRPC stream gives, too
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'resync').length).toBeGreaterThan(afterAttach);

    unsubscribe();
  });
});

// ---- readiness -----------------------------------------------------------------
//
// `ComposeApplication` has no field for `ContainerSpec.readiness` at all (see
// `compose.ts`'s `READINESS_LABEL` doc) -- so the model handed to `apply()`
// only carries a probe when its `labels` include the adapter's own
// `fiber-servo.readiness` convention, which is what `withReadiness` attaches
// here the way an upstream builder would have to.

describe('containerd runtime: readiness prober', () => {
  it('probes via `compose -f <file> exec <service> <probe...>` until it exits 0, then reports ready', async () => {
    const fc = createFakeContainerd();
    const composeFile = tempComposeFile();
    const runtime = runtimeFor(fc, { composeFile, probeTickMs: 5 });
    fc.probeResults.set('app', fail('not ready yet'));
    const spec = withReadiness(model([{ name: 'app', image: 'app:1' }]), 'app', {
      exec: ['pg_isready'],
      intervalMs: 5, // matters: the default (2000) would put the second attempt past this test's end
    });
    await runtime.apply(spec);

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => void events.push(e));
    await new Promise((r) => setTimeout(r, 15));
    expect(events.some((e) => e.type === 'container' && e.container.ready === true)).toBe(false);

    fc.probeResults.set('app', ok());
    await new Promise((r) => setTimeout(r, 15));
    unsubscribe();

    expect(events).toContainEqual({
      type: 'container',
      container: expect.objectContaining({ name: 'app', ready: true }),
    });
    expect(fc.calls).toContainEqual(`compose -f ${composeFile} exec app pg_isready`);
  });

  it('a service replaced by apply() starts unready again; an unchanged one keeps its ready state', async () => {
    const fc = createFakeContainerd();
    const runtime = runtimeFor(fc, { probeTickMs: 5 });
    fc.probeResults.set('app', ok());
    fc.probeResults.set('sidecar', ok());
    const spec = withReadiness(
      withReadiness(
        model([
          { name: 'app', image: 'app:1' },
          { name: 'sidecar', image: 'proxy:1' },
        ]),
        'app',
        {
          exec: ['true'],
          intervalMs: 5,
        },
      ),
      'sidecar',
      { exec: ['true'], intervalMs: 5 },
    );
    await runtime.apply(spec);

    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => void events.push(e));
    await new Promise((r) => setTimeout(r, 15)); // both go ready
    unsubscribe();

    const nextSpec = withReadiness(
      withReadiness(
        model([
          { name: 'app', image: 'app:2' },
          { name: 'sidecar', image: 'proxy:1' },
        ]),
        'app',
        {
          exec: ['true'],
          intervalMs: 5,
        },
      ),
      'sidecar',
      { exec: ['true'], intervalMs: 5 },
    );
    await runtime.apply(nextSpec); // app replaced (image changed), sidecar untouched

    const state = await runtime.inspect();
    expect(state.containers.get('app')?.ready).toBe(false); // recreated: unready until probed again
    expect(state.containers.get('sidecar')?.ready).toBe(true); // never touched: still ready
  });
});
