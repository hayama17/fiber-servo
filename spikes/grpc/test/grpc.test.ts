/**
 * The spike's proof. Needs no containerd: `startFakeContainerd()` is a real
 * gRPC server built from the same vendored protos, on a unix socket in a
 * temp dir.
 *
 * What each block is meant to establish is stated in its name; what the
 * spike could NOT establish is listed in ../README.md and in
 * docs/grpc-design.md.
 */
import * as grpc from '@grpc/grpc-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { interpretEvent, type StatusEvent } from '../../../src/index.js';
import { OCI_SPEC_TYPE_URL, packProto, unpackProto } from '../src/any.js';
import { NAMESPACE_HEADER, connect, socketTarget } from '../src/client.js';
import { envelopeToEventRow, type Envelope } from '../src/events.js';
import { startFakeContainerd, type FakeContainerd } from '../src/fake-containerd.js';
import { createGrpcDriver, type ContainerDriver } from '../src/driver.js';
import { PROTO_FILES, messageType, packageDefinition, serviceClientConstructor } from '../src/protos.js';
import type { OciSpec } from '../src/oci.js';

const IMAGE = 'docker.io/library/nginx:1.27';
const CHAIN_ID = 'sha256:6a1f1e1d0c0b0a09080706050403020100ffeeddccbbaa99887766554433221100';
const LABELS = { 'fiber-servo.managed': 'true', 'fiber-servo.spec': 'deadbeef' };

describe('the protos', () => {
  it('load from the vendored containerd API module with no external includes', () => {
    const definition = packageDefinition();
    for (const service of [
      'containerd.services.containers.v1.Containers',
      'containerd.services.tasks.v1.Tasks',
      'containerd.services.events.v1.Events',
      'containerd.services.snapshots.v1.Snapshots',
      'containerd.services.images.v1.Images',
    ]) {
      expect(definition[service], service).toBeDefined();
    }
    // containerd 2.x moved the envelope from the events service package into
    // containerd.types (types/event.proto). On 1.7 this name does not exist.
    expect(definition['containerd.types.Envelope']).toBeDefined();
    expect(PROTO_FILES.length).toBe(8);
  });

  it('round-trips an event body through google.protobuf.Any the way containerd packs it', () => {
    const any = packProto('containerd.events.TaskExit', {
      container_id: 'web',
      id: 'web',
      pid: 42,
      exit_status: 137,
    });
    // typeurl v2 uses the bare protobuf full name, not type.googleapis.com/...
    expect(any.type_url).toBe('containerd.events.TaskExit');
    expect(unpackProto(any)).toMatchObject({ container_id: 'web', exit_status: 137 });
  });
});

describe('the connection', () => {
  it('turns containerd default address into a unix target', () => {
    expect(socketTarget('/run/containerd/containerd.sock')).toBe('unix:///run/containerd/containerd.sock');
    expect(socketTarget('unix:///run/containerd/containerd.sock')).toBe(
      'unix:///run/containerd/containerd.sock',
    );
  });

  it('names the namespace header containerd actually reads', () => {
    // pkg/namespaces/grpc.go: GRPCHeader. The ttrpc variant, used only to
    // talk to shims directly, is `containerd-namespace-ttrpc`.
    expect(NAMESPACE_HEADER).toBe('containerd-namespace');
  });
});

describe('driving a fake containerd', () => {
  let fake: FakeContainerd;
  let driver: ContainerDriver;

  beforeEach(async () => {
    fake = await startFakeContainerd();
    fake.putImage(IMAGE, CHAIN_ID);
    driver = createGrpcDriver({ address: fake.address, namespace: 'default' });
  });

  afterEach(async () => {
    await driver.close();
    await fake.stop();
  });

  it('refuses a call with no containerd-namespace header, as containerd does', async () => {
    const Ctor = serviceClientConstructor('containerd.services.containers.v1.Containers');
    const client = new Ctor(socketTarget(fake.address), grpc.credentials.createInsecure()) as grpc.Client &
      Record<string, unknown>;
    const call = client['List'] as (
      request: object,
      metadata: grpc.Metadata,
      callback: (error: grpc.ServiceError | null, response?: unknown) => void,
    ) => void;
    const failure = await new Promise<grpc.ServiceError | null>((resolve) => {
      call.call(client, { filters: [] }, new grpc.Metadata(), (error) => resolve(error));
    });
    client.close();
    expect(failure?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(failure?.details).toContain('namespace is required');
    // ... and the same call through the driver, which sets the header, works.
    expect(await driver.list()).toEqual([]);
  });

  it('creates a container: image lookup, snapshot, then the container record with a hand-built OCI spec', async () => {
    const info = await driver.create(
      { name: 'web', image: IMAGE, command: ['nginx', '-g', 'daemon off;'], env: { TZ: 'UTC' } },
      LABELS,
    );
    expect(info).toMatchObject({ name: 'web', id: 'web', digest: 'deadbeef' });
    expect(fake.calls).toEqual([
      'containerd.services.images.v1.Images/Get',
      'containerd.services.snapshots.v1.Snapshots/Prepare',
      'containerd.services.containers.v1.Containers/Create',
    ]);

    const record = fake.containers.get('web');
    expect(record).toBeDefined();
    expect(record?.snapshotter).toBe('overlayfs');
    expect(record?.snapshot_key).toBe('web');
    expect(record?.runtime.name).toBe('io.containerd.runc.v2');

    // The spec is JSON under a typeurl-registered URL, not a protobuf message.
    expect(record?.spec.type_url).toBe(OCI_SPEC_TYPE_URL);
    const spec = JSON.parse(Buffer.from(record?.spec.value ?? []).toString('utf8')) as OciSpec;
    expect(spec.process.args).toEqual(['nginx', '-g', 'daemon off;']);
    expect(spec.process.env).toContain('TZ=UTC');
    expect(spec.root.path).toBe('rootfs');
    expect(spec.linux.cgroupsPath).toBe('/default/web');
    expect(spec.mounts.map((mount) => mount.destination)).toContain('/proc');
    expect(spec.process.capabilities.bounding).toContain('CAP_NET_BIND_SERVICE');
  });

  it('will not create a task without rootfs mounts, so start reads them from the snapshotter', async () => {
    await driver.create({ name: 'web', image: IMAGE, command: ['sleep', '1'] }, LABELS);
    fake.calls.length = 0;
    await driver.start('web');
    expect(fake.calls).toEqual([
      'containerd.services.tasks.v1.Tasks/Get', // is there a task already?
      'containerd.services.snapshots.v1.Snapshots/Mounts', // rootfs for the shim
      'containerd.services.tasks.v1.Tasks/Create',
      'containerd.services.tasks.v1.Tasks/Start',
    ]);
    expect(fake.tasks.get('web')?.status).toBe('RUNNING');
    expect(fake.tasks.get('web')?.rootfs).toHaveLength(1);
  });

  it('reports lifecycle on the event stream, including a synthesised /tasks/exit', async () => {
    await driver.create({ name: 'web', image: IMAGE, command: ['sleep', '1'] }, LABELS);
    const seen: StatusEvent[] = [];
    const stop = new AbortController();
    const pump = (async () => {
      for await (const event of driver.events(stop.signal)) seen.push(event);
    })();
    await waitFor(() => fake.calls.some((call) => call.endsWith('Events/Subscribe')));

    await driver.start('web');
    await waitFor(() => seen.length >= 1);
    expect(seen[0]).toEqual({ kind: 'set', name: 'web', state: 'running' });

    fake.exitTask('web', 137);
    await waitFor(() => seen.length >= 2);
    expect(seen[1]).toEqual({ kind: 'set', name: 'web', state: 'dead', exitCode: 137 });

    // Events.Subscribe is cross-namespace unless filtered; the driver filters.
    fake.publish('other', '/tasks/exit', 'containerd.events.TaskExit', {
      container_id: 'web',
      id: 'web',
      exit_status: 1,
    });
    await sleep(50);
    expect(seen).toHaveLength(2);

    stop.abort();
    await pump;
  });

  it('produces exactly the row shape interpretEvent in src/runtime/containerd/events.ts consumes', async () => {
    const envelopes: Envelope[] = [];
    const connection = connect({ address: fake.address, namespace: 'default' });
    const stop = new AbortController();
    const pump = (async () => {
      for await (const envelope of connection.stream<Envelope>(
        'containerd.services.events.v1.Events',
        'Subscribe',
        { filters: ['namespace==default'] },
        stop.signal,
      )) {
        envelopes.push(envelope);
      }
    })();
    await waitFor(() => fake.calls.some((call) => call.endsWith('Events/Subscribe')));

    await driver.create({ name: 'web', image: IMAGE, command: ['sleep', '1'] }, LABELS);
    await driver.start('web');
    fake.exitTask('web', 137);
    await waitFor(() => envelopes.some((envelope) => envelope.topic === '/tasks/exit'));
    stop.abort();
    await pump;
    connection.close();

    const rows = envelopes.map(envelopeToEventRow);
    const index = new Map([['web', 'web']]);
    const interpreted = rows
      .filter((row) => row !== null)
      .map((row) => interpretEvent(row, (id) => index.get(id)))
      .filter((event) => event !== null);

    // The existing watcher's translation, unchanged, over gRPC bodies.
    expect(interpreted).toEqual([
      { kind: 'set', name: 'web', state: 'running' },
      { kind: 'set', name: 'web', state: 'dead', exitCode: 137 },
    ]);
  });

  it('identifies a container event by `id`, which is not where task events keep it', () => {
    // events/container.proto: ContainerDelete has `id`, not `container_id`.
    // Reading only `container_id` leaves the row anonymous and the store
    // never forgets the container.
    const row = envelopeToEventRow({
      topic: '/containers/delete',
      event: packProto('containerd.events.ContainerDelete', { id: 'web' }),
    });
    expect(row?.ID).toBe('web');
    expect(interpretEvent(row!, () => 'web')).toEqual({ kind: 'remove', name: 'web' });
  });

  it('normalises the empty exec id on /tasks/exit, which interpretEvent would otherwise drop', () => {
    // events/task.proto, TaskDelete: "id is the specific exec. By default if
    // omitted will be `""` thus matches the init exec". A protobuf decode
    // with defaults gives `id: ''`, and interpretEvent compares it to
    // container_id, so an un-normalised row is silently ignored: the
    // container would die and the tree would never hear about it.
    const raw = messageType('containerd.events.TaskExit').deserialize(
      packProto('containerd.events.TaskExit', { container_id: 'web', exit_status: 3 }).value,
    );
    expect(raw['id']).toBe('');
    expect(interpretEvent({ ID: 'web', Topic: '/tasks/exit', Event: raw }, () => 'web')).toBeNull();

    const row = envelopeToEventRow({
      topic: '/tasks/exit',
      event: packProto('containerd.events.TaskExit', { container_id: 'web', exit_status: 3 }),
    });
    expect(row).not.toBeNull();
    expect(interpretEvent(row!, () => 'web')).toEqual({
      kind: 'set',
      name: 'web',
      state: 'dead',
      exitCode: 3,
    });
  });

  it('lists only managed containers, with the label filter evaluated by the server', async () => {
    await driver.create({ name: 'web', image: IMAGE, command: ['sleep', '1'] }, LABELS);
    await driver.create({ name: 'stray', image: IMAGE, command: ['sleep', '1'] }, { other: 'true' });
    await driver.start('web');

    const listed = await driver.list();
    expect(listed.map((info) => info.name)).toEqual(['web']);
    expect(listed[0]).toMatchObject({ state: 'running', digest: 'deadbeef' });
    // What prune() needs: the set of managed names, from the runtime, by label.
    expect(fake.containers.has('stray')).toBe(true);
  });

  it('inspects a created-but-not-started container as dead, which is what adoption keys on', async () => {
    await driver.create({ name: 'web', image: IMAGE, command: ['sleep', '1'] }, LABELS);
    expect(await driver.inspect('web')).toMatchObject({ name: 'web', state: 'dead', digest: 'deadbeef' });
    await driver.start('web');
    expect(await driver.inspect('web')).toMatchObject({ state: 'running' });
    expect(await driver.inspect('nothing')).toBeNull();
  });

  it('runs a readiness probe as an exec process and reads its exit code', async () => {
    await driver.create({ name: 'db', image: IMAGE, command: ['sleep', '1'] }, LABELS);
    await driver.start('db');
    fake.calls.length = 0;
    const outcome = await driver.exec('db', ['pg_isready', '-U', 'postgres']);
    expect(outcome.code).toBe(0);
    expect(fake.calls).toEqual([
      'containerd.services.tasks.v1.Tasks/Exec',
      'containerd.services.tasks.v1.Tasks/Start',
      'containerd.services.tasks.v1.Tasks/Wait',
      'containerd.services.tasks.v1.Tasks/DeleteProcess',
    ]);
  });

  it('removes the task, the container record and the snapshot, and tolerates what is already gone', async () => {
    await driver.create({ name: 'web', image: IMAGE, command: ['sleep', '1'] }, LABELS);
    await driver.start('web');
    fake.calls.length = 0;
    await driver.remove('web');
    expect(fake.containers.has('web')).toBe(false);
    expect(fake.tasks.has('web')).toBe(false);
    expect(fake.calls).toContain('containerd.services.snapshots.v1.Snapshots/Remove');
    await expect(driver.remove('web')).resolves.toBeUndefined();
  });

  it('refuses networks with a clear error rather than pretending', async () => {
    await expect(driver.createNetwork({ name: 'app' }, LABELS)).rejects.toThrow(/cannot do networks/);
    expect(driver.capabilities).toEqual({ pull: false, networks: false, publish: false, exec: true });
  });

  it('says plainly when the image is not in the image store, instead of pulling', async () => {
    await expect(driver.create({ name: 'web', image: 'docker.io/library/redis:7' }, LABELS)).rejects.toThrow(
      /image .* not found|not in containerd/,
    );
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the spike to make progress');
    await sleep(10);
  }
}
