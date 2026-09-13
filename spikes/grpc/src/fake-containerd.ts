/**
 * A fake containerd: a real gRPC server, built from the real protos, that
 * answers the calls this spike drives. It exists so the client can be
 * exercised end to end with no containerd, no root, and no images, in a
 * vitest run that takes about a second.
 *
 * It is a fake, not a mock: it speaks the wire protocol over a unix socket,
 * enforces the `containerd-namespace` header the way containerd does, keeps
 * container and task records, evaluates the label filter on
 * `Containers.List`, and publishes proper `containerd.types.Envelope`s with
 * protobuf-packed `google.protobuf.Any` bodies on `Events.Subscribe`. What it
 * does not do is anything below the API: no runc, no snapshots on disk, no
 * process ever runs. Exits are synthesised by the test through `exitTask()`.
 */
import * as grpc from '@grpc/grpc-js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packProto } from './any.js';
import { NAMESPACE_HEADER } from './client.js';
import { serviceDefinition } from './protos.js';

interface ContainerRecord {
  id: string;
  image: string;
  labels: Record<string, string>;
  snapshotter: string;
  snapshot_key: string;
  runtime: { name: string };
  spec: { type_url: string; value: Buffer };
}

interface TaskRecord {
  id: string;
  pid: number;
  status: 'CREATED' | 'RUNNING' | 'STOPPED';
  exit_status: number;
  rootfs: unknown[];
}

/** A unary handler, typed once so every method below is checked. */
type Unary = (
  call: grpc.ServerUnaryCall<Record<string, unknown>, object>,
  callback: grpc.sendUnaryData<object>,
) => void;
type ServiceImpl = Record<string, Unary>;

interface Subscriber {
  filters: string[];
  write(envelope: object): void;
}

export interface FakeContainerd {
  /** The socket path; pass it to the driver as `address`. */
  address: string;
  /** Every RPC the server received, as `Service/Method`, in order. */
  calls: string[];
  containers: Map<string, ContainerRecord>;
  tasks: Map<string, TaskRecord>;
  /** Register an image the driver can resolve, with its rootfs chain id. */
  putImage(name: string, chainId: string, snapshotter?: string): void;
  /** Synthesise what the shim would publish when the init process dies. */
  exitTask(id: string, exitStatus: number): void;
  /** Publish an arbitrary envelope, e.g. in another namespace. */
  publish(namespace: string, topic: string, typeName: string, body: object): void;
  stop(): Promise<void>;
}

const CONTAINERS = 'containerd.services.containers.v1.Containers';
const TASKS = 'containerd.services.tasks.v1.Tasks';
const EVENTS = 'containerd.services.events.v1.Events';
const SNAPSHOTS = 'containerd.services.snapshots.v1.Snapshots';
const IMAGES = 'containerd.services.images.v1.Images';

export async function startFakeContainerd(): Promise<FakeContainerd> {
  const address = join(mkdtempSync(join(tmpdir(), 'fake-containerd-')), 'containerd.sock');
  const containers = new Map<string, ContainerRecord>();
  const tasks = new Map<string, TaskRecord>();
  const images = new Map<string, { name: string; labels: Record<string, string> }>();
  const subscribers = new Set<Subscriber>();
  const calls: string[] = [];
  let nextPid = 1000;

  function namespaceOf(call: { metadata: grpc.Metadata }, what: string): string {
    calls.push(what);
    const value = call.metadata.get(NAMESPACE_HEADER)[0];
    if (typeof value !== 'string' || value === '') {
      // containerd: "namespace is required" on every call without the header.
      throw error(grpc.status.INVALID_ARGUMENT, 'namespace is required');
    }
    return value;
  }

  function publish(namespace: string, topic: string, typeName: string, body: object): void {
    const now = Date.now();
    const envelope = {
      timestamp: { seconds: String(Math.floor(now / 1000)), nanos: (now % 1000) * 1e6 },
      namespace,
      topic,
      event: packProto(typeName, body),
    };
    for (const subscriber of subscribers) {
      if (matchesFilters(subscriber.filters, namespace, topic)) subscriber.write(envelope);
    }
  }

  const containersImpl: ServiceImpl = {
    Create(call, callback) {
      wrap(callback, () => {
        const namespace = namespaceOf(call, `${CONTAINERS}/Create`);
        const input = (call.request as { container?: Partial<ContainerRecord> }).container ?? {};
        const id = String(input.id ?? '');
        if (!id) throw error(grpc.status.INVALID_ARGUMENT, 'container id is required');
        if (containers.has(id)) throw error(grpc.status.ALREADY_EXISTS, `container ${id} already exists`);
        const record: ContainerRecord = {
          id,
          image: String(input.image ?? ''),
          labels: { ...(input.labels ?? {}) },
          snapshotter: String(input.snapshotter ?? ''),
          snapshot_key: String(input.snapshot_key ?? ''),
          runtime: { name: String(input.runtime?.name ?? '') },
          spec: input.spec ?? { type_url: '', value: Buffer.alloc(0) },
        };
        containers.set(id, record);
        publish(namespace, '/containers/create', 'containerd.events.ContainerCreate', {
          id,
          image: record.image,
          runtime: { name: record.runtime.name },
        });
        return { container: record };
      });
    },
    Get(call, callback) {
      wrap(callback, () => {
        namespaceOf(call, `${CONTAINERS}/Get`);
        const id = String((call.request as { id?: string }).id ?? '');
        const container = containers.get(id);
        if (!container) throw error(grpc.status.NOT_FOUND, `container ${id} not found`);
        return { container };
      });
    },
    List(call, callback) {
      wrap(callback, () => {
        namespaceOf(call, `${CONTAINERS}/List`);
        const filters = (call.request as { filters?: string[] }).filters ?? [];
        const matching = [...containers.values()].filter((container) =>
          filters.length === 0
            ? true
            : filters.some((filter) => matchesLabelFilter(filter, container.labels)),
        );
        return { containers: matching };
      });
    },
    Delete(call, callback) {
      wrap(callback, () => {
        const namespace = namespaceOf(call, `${CONTAINERS}/Delete`);
        const id = String((call.request as { id?: string }).id ?? '');
        if (!containers.delete(id)) throw error(grpc.status.NOT_FOUND, `container ${id} not found`);
        publish(namespace, '/containers/delete', 'containerd.events.ContainerDelete', { id });
        return {};
      });
    },
  };

  const tasksImpl: ServiceImpl = {
    Create(call, callback) {
      wrap(callback, () => {
        const namespace = namespaceOf(call, `${TASKS}/Create`);
        const request = call.request as { container_id?: string; rootfs?: unknown[] };
        const id = String(request.container_id ?? '');
        if (!containers.has(id)) throw error(grpc.status.NOT_FOUND, `container ${id} not found`);
        if (tasks.has(id)) throw error(grpc.status.ALREADY_EXISTS, `task ${id} already exists`);
        // containerd cannot start a task without rootfs mounts.
        if (!request.rootfs || request.rootfs.length === 0) {
          throw error(grpc.status.INVALID_ARGUMENT, `task ${id}: rootfs mounts are required`);
        }
        const task: TaskRecord = {
          id,
          pid: nextPid++,
          status: 'CREATED',
          exit_status: 0,
          rootfs: request.rootfs,
        };
        tasks.set(id, task);
        publish(namespace, '/tasks/create', 'containerd.events.TaskCreate', {
          container_id: id,
          pid: task.pid,
        });
        return { container_id: id, pid: task.pid };
      });
    },
    Start(call, callback) {
      wrap(callback, () => {
        const namespace = namespaceOf(call, `${TASKS}/Start`);
        const request = call.request as { container_id?: string; exec_id?: string };
        const id = String(request.container_id ?? '');
        const task = tasks.get(id);
        if (!task) throw error(grpc.status.NOT_FOUND, `task ${id} not found`);
        if (request.exec_id) {
          publish(namespace, '/tasks/exec-started', 'containerd.events.TaskExecStarted', {
            container_id: id,
            exec_id: request.exec_id,
            pid: nextPid++,
          });
          return { pid: nextPid };
        }
        task.status = 'RUNNING';
        publish(namespace, '/tasks/start', 'containerd.events.TaskStart', {
          container_id: id,
          pid: task.pid,
        });
        return { pid: task.pid };
      });
    },
    Get(call, callback) {
      wrap(callback, () => {
        namespaceOf(call, `${TASKS}/Get`);
        const id = String((call.request as { container_id?: string }).container_id ?? '');
        const task = tasks.get(id);
        if (!task) throw error(grpc.status.NOT_FOUND, `task ${id} not found`);
        return { process: processOf(task) };
      });
    },
    List(call, callback) {
      wrap(callback, () => {
        namespaceOf(call, `${TASKS}/List`);
        return { tasks: [...tasks.values()].map(processOf) };
      });
    },
    Kill(call, callback) {
      wrap(callback, () => {
        namespaceOf(call, `${TASKS}/Kill`);
        const request = call.request as { container_id?: string; signal?: number };
        const id = String(request.container_id ?? '');
        const task = tasks.get(id);
        if (!task) throw error(grpc.status.NOT_FOUND, `task ${id} not found`);
        exitTask(id, 128 + Number(request.signal ?? 15));
        return {};
      });
    },
    Delete(call, callback) {
      wrap(callback, () => {
        const namespace = namespaceOf(call, `${TASKS}/Delete`);
        const id = String((call.request as { container_id?: string }).container_id ?? '');
        const task = tasks.get(id);
        if (!task) throw error(grpc.status.NOT_FOUND, `task ${id} not found`);
        tasks.delete(id);
        publish(namespace, '/tasks/delete', 'containerd.events.TaskDelete', {
          container_id: id,
          pid: task.pid,
          exit_status: task.exit_status,
          id,
        });
        return { id, pid: task.pid, exit_status: task.exit_status };
      });
    },
    Exec(call, callback) {
      wrap(callback, () => {
        const namespace = namespaceOf(call, `${TASKS}/Exec`);
        const request = call.request as { container_id?: string; exec_id?: string };
        const id = String(request.container_id ?? '');
        const task = tasks.get(id);
        if (!task || task.status !== 'RUNNING') {
          throw error(grpc.status.FAILED_PRECONDITION, `task ${id} is not running`);
        }
        publish(namespace, '/tasks/exec-added', 'containerd.events.TaskExecAdded', {
          container_id: id,
          exec_id: String(request.exec_id ?? ''),
        });
        return {};
      });
    },
    Wait(call, callback) {
      wrap(callback, () => {
        namespaceOf(call, `${TASKS}/Wait`);
        const request = call.request as { container_id?: string; exec_id?: string };
        // The fake's exec processes always succeed immediately; a real one
        // blocks until the process exits.
        if (request.exec_id) return { exit_status: 0, exited_at: null };
        const task = tasks.get(String(request.container_id ?? ''));
        if (!task) throw error(grpc.status.NOT_FOUND, 'task not found');
        return { exit_status: task.exit_status, exited_at: null };
      });
    },
    DeleteProcess(call, callback) {
      wrap(callback, () => {
        namespaceOf(call, `${TASKS}/DeleteProcess`);
        const request = call.request as { container_id?: string; exec_id?: string };
        return { id: String(request.exec_id ?? ''), pid: 0, exit_status: 0 };
      });
    },
  };

  const eventsImpl = {
    Subscribe(stream: grpc.ServerWritableStream<{ filters?: string[] }, object>) {
      try {
        namespaceOf(stream, `${EVENTS}/Subscribe`);
      } catch (e) {
        stream.destroy(e as Error);
        return;
      }
      const subscriber: Subscriber = {
        filters: stream.request.filters ?? [],
        write: (envelope) => stream.write(envelope),
      };
      subscribers.add(subscriber);
      const drop = (): void => void subscribers.delete(subscriber);
      stream.on('cancelled', drop);
      stream.on('close', drop);
      stream.on('error', drop);
    },
  };

  const snapshotsImpl: ServiceImpl = {
    Prepare(call, callback) {
      wrap(callback, () => {
        namespaceOf(call, `${SNAPSHOTS}/Prepare`);
        const request = call.request as { key?: string; parent?: string };
        if (!request.parent) throw error(grpc.status.INVALID_ARGUMENT, 'parent is required');
        return { mounts: mountsFor(String(request.key ?? ''), String(request.parent)) };
      });
    },
    Mounts(call, callback) {
      wrap(callback, () => {
        namespaceOf(call, `${SNAPSHOTS}/Mounts`);
        const key = String((call.request as { key?: string }).key ?? '');
        return { mounts: mountsFor(key, 'chain') };
      });
    },
    Remove(call, callback) {
      wrap(callback, () => {
        namespaceOf(call, `${SNAPSHOTS}/Remove`);
        return {};
      });
    },
  };

  const imagesImpl: ServiceImpl = {
    Get(call, callback) {
      wrap(callback, () => {
        namespaceOf(call, `${IMAGES}/Get`);
        const name = String((call.request as { name?: string }).name ?? '');
        const image = images.get(name);
        if (!image) throw error(grpc.status.NOT_FOUND, `image ${name} not found`);
        return { image };
      });
    },
  };

  function exitTask(id: string, exitStatus: number): void {
    const task = tasks.get(id);
    if (!task) return;
    task.status = 'STOPPED';
    task.exit_status = exitStatus;
    const now = Date.now();
    // The shim sets `id` to the container id for the init process. The
    // adapter also has to cope with it being empty; see src/events.ts.
    publish('default', '/tasks/exit', 'containerd.events.TaskExit', {
      container_id: id,
      id,
      pid: task.pid,
      exit_status: exitStatus,
      exited_at: { seconds: String(Math.floor(now / 1000)), nanos: 0 },
    });
  }

  const server = new grpc.Server();
  server.addService(serviceDefinition(CONTAINERS), asService(containersImpl));
  server.addService(serviceDefinition(TASKS), asService(tasksImpl));
  server.addService(serviceDefinition(EVENTS), asService(eventsImpl));
  server.addService(serviceDefinition(SNAPSHOTS), asService(snapshotsImpl));
  server.addService(serviceDefinition(IMAGES), asService(imagesImpl));

  await new Promise<void>((resolve, reject) => {
    server.bindAsync(`unix://${address}`, grpc.ServerCredentials.createInsecure(), (e) =>
      e ? reject(e) : resolve(),
    );
  });

  return {
    address,
    calls,
    containers,
    tasks,
    putImage(name, chainId, snapshotter = 'overlayfs') {
      images.set(name, {
        name,
        labels: { [`containerd.io/gc.ref.snapshot.${snapshotter}`]: chainId },
      });
    },
    exitTask,
    publish,
    stop() {
      for (const subscriber of subscribers) subscriber.write = () => {};
      subscribers.clear();
      return new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    },
  };
}

function asService(impl: object): grpc.UntypedServiceImplementation {
  return impl as unknown as grpc.UntypedServiceImplementation;
}

function processOf(task: TaskRecord): object {
  return { id: task.id, pid: task.pid, status: task.status, exit_status: task.exit_status };
}

function mountsFor(key: string, parent: string): object[] {
  return [
    {
      type: 'overlay',
      source: 'overlay',
      target: '',
      options: [`lowerdir=/var/lib/containerd/snapshots/${parent}`, `upperdir=/var/lib/containerd/rw/${key}`],
    },
  ];
}

/** `labels."fiber-servo.managed"=="true"`, the subset of containerd's filter syntax the driver uses. */
function matchesLabelFilter(filter: string, labels: Record<string, string>): boolean {
  const match = /^labels\."([^"]+)"=="([^"]*)"$/.exec(filter.trim());
  if (!match) return true;
  return labels[match[1] as string] === match[2];
}

/** `namespace==default`, `topic==/tasks/exit`. Anything else matches. */
function matchesFilters(filters: readonly string[], namespace: string, topic: string): boolean {
  return filters.every((filter) => {
    const match = /^(namespace|topic)==(.*)$/.exec(filter.trim());
    if (!match) return true;
    return match[1] === 'namespace' ? match[2] === namespace : match[2] === topic;
  });
}

function error(code: grpc.status, message: string): grpc.ServiceError {
  return Object.assign(new Error(message), { code, details: message, metadata: new grpc.Metadata() });
}

function wrap(callback: grpc.sendUnaryData<object>, body: () => object): void {
  try {
    callback(null, body());
  } catch (e) {
    callback(e as grpc.ServiceError, null);
  }
}
