/**
 * The seam this spike argues for, and a gRPC implementation of the part of
 * it the spike can prove.
 *
 * `ContainerDriver` is the interface proposed in docs/grpc-design.md: the
 * operations `execute.ts` and `events.ts` actually perform, named as
 * containerd names them rather than as nerdctl spells them. The nerdctl
 * driver is today's code with its argv building moved one file down; this
 * file is the other implementation.
 *
 * What is deliberately NOT here: image pull, and networks. Both are real
 * gaps, not oversights; see docs/grpc-design.md sections 3 and 4.
 */
import type { ContainerSpec, NetworkSpec } from '../../../src/ops.js';
import type { StatusEvent } from '../../../src/runtime/containerd/events.js';
import type { ContainerState } from '../../../src/status.js';
import { OCI_PROCESS_TYPE_URL, OCI_SPEC_TYPE_URL, packJson } from './any.js';
import {
  connect,
  isNotFound,
  type ContainerdConnection,
  type ContainerdConnectionOptions,
} from './client.js';
import { envelopeToEventRow, namespaceFilter, type Envelope, type EventRow } from './events.js';
import { buildSpec, type ImageConfig, type OciSpec } from './oci.js';

// ---- the proposed interface ------------------------------------------------

/** What the executor and the watcher need to know about one container. */
export interface ContainerInfo {
  /** fiber-servo's name. On containerd this is the container id itself. */
  name: string;
  /** The runtime's own id. Equal to `name` on containerd; a 64-hex string on nerdctl. */
  id: string;
  state: ContainerState;
  exitCode?: number;
  /** Value of the `fiber-servo.spec` label, for adoption. */
  digest?: string;
}

export interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export interface NetworkInfo {
  name: string;
  digest?: string;
}

/** What a driver can and cannot do, so the executor can refuse early and clearly. */
export interface DriverCapabilities {
  /** Can pull an image from a registry. */
  pull: boolean;
  /** Can create and attach CNI networks, and give containers name resolution. */
  networks: boolean;
  /** Can publish host ports. */
  publish: boolean;
  /** Can run a process inside a running container (readiness probes). */
  exec: boolean;
}

/**
 * The one interface both runtimes implement. Every method is addressed by
 * fiber-servo's `name` (decision 3), and every method is allowed to be slow;
 * serialising them stays the executor's job.
 */
export interface ContainerDriver {
  readonly kind: string;
  readonly capabilities: DriverCapabilities;

  /** Create and start are separate: `START` must be able to restart a stopped container. */
  create(spec: ContainerSpec, labels: Readonly<Record<string, string>>): Promise<ContainerInfo>;
  start(name: string): Promise<void>;
  /** SIGTERM, then SIGKILL after `timeoutMs`. */
  stop(name: string, options?: { timeoutMs?: number }): Promise<void>;
  /** Stop if running, then delete. Absent is success. */
  remove(name: string): Promise<void>;
  inspect(name: string): Promise<ContainerInfo | null>;
  /** Every container carrying the managed label. What `prune()` and the initial sync need. */
  list(): Promise<ContainerInfo[]>;
  /** Readiness probes. Only the exit code is used. */
  exec(name: string, argv: readonly string[], options?: { timeoutMs?: number }): Promise<ExecOutcome>;
  /** Lifecycle, already reduced to what the status store takes. Ends when `signal` aborts. */
  events(signal?: AbortSignal): AsyncIterable<StatusEvent>;

  createNetwork(spec: NetworkSpec, labels: Readonly<Record<string, string>>): Promise<void>;
  inspectNetwork(name: string): Promise<NetworkInfo | null>;
  listNetworks(): Promise<NetworkInfo[]>;
  removeNetwork(name: string): Promise<void>;

  close(): Promise<void>;
}

// ---- the gRPC implementation ----------------------------------------------

const CONTAINERS = 'containerd.services.containers.v1.Containers';
const TASKS = 'containerd.services.tasks.v1.Tasks';
const EVENTS = 'containerd.services.events.v1.Events';
const SNAPSHOTS = 'containerd.services.snapshots.v1.Snapshots';
const IMAGES = 'containerd.services.images.v1.Images';

/** containerd's defaults for linux (defaults/defaults_linux.go). */
export const DEFAULT_RUNTIME = 'io.containerd.runc.v2';
export const DEFAULT_SNAPSHOTTER = 'overlayfs';

/**
 * The label containerd's unpacker writes on the image's *config blob* in the
 * content store, holding the chain id of the unpacked rootfs
 * (core/unpack/unpacker.go and client/image.go). Reading it is how a client
 * finds the snapshot to use as a parent without computing chain ids itself.
 */
export const SNAPSHOT_REF_LABEL_PREFIX = 'containerd.io/gc.ref.snapshot.';

/** What a container needs from its image, once the image is pulled and unpacked. */
export interface ResolvedImage {
  /** Chain id of the unpacked rootfs: the parent of the container's snapshot. */
  parent: string;
  /** From the image's config blob. Supplies Entrypoint / Cmd / Env / WorkingDir. */
  config?: ImageConfig;
}

export interface GrpcDriverOptions extends ContainerdConnectionOptions {
  snapshotter?: string;
  runtime?: string;
  managedLabel?: string;
  specLabel?: string;
  /**
   * Resolve an image record to what a container needs from it. The default
   * reads the rootfs chain id from the image's labels and returns no config;
   * on a real containerd both come from the content store (manifest blob ->
   * config blob -> its `containerd.io/gc.ref.snapshot.<snapshotter>` label),
   * which needs the content service this spike does not vendor. See
   * docs/grpc-design.md section 3.
   */
  resolveImage?: (name: string, image: Record<string, unknown>) => ResolvedImage;
}

interface TaskProcess {
  id?: string;
  status?: string;
  exit_status?: number;
  pid?: number;
}

export function createGrpcDriver(options: GrpcDriverOptions = {}): ContainerDriver {
  const connection: ContainerdConnection = connect(options);
  const snapshotter = options.snapshotter ?? DEFAULT_SNAPSHOTTER;
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const managedLabel = options.managedLabel ?? 'fiber-servo.managed';
  const specLabel = options.specLabel ?? 'fiber-servo.spec';
  const resolveImage = options.resolveImage ?? defaultResolveImage(snapshotter);

  async function imageFor(name: string): Promise<ResolvedImage> {
    const response = await connection.call<{ image?: Record<string, unknown> }>(IMAGES, 'Get', { name });
    if (!response.image) throw new Error(`image ${name} is not in containerd's image store; pull it first`);
    return resolveImage(name, response.image);
  }

  async function mountsFor(name: string): Promise<object[]> {
    const response = await connection.call<{ mounts?: object[] }>(SNAPSHOTS, 'Mounts', {
      snapshotter,
      key: name,
    });
    return response.mounts ?? [];
  }

  async function taskOf(name: string): Promise<TaskProcess | null> {
    try {
      const response = await connection.call<{ process?: TaskProcess }>(TASKS, 'Get', {
        container_id: name,
        exec_id: '',
      });
      return response.process ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  function infoOf(container: Record<string, unknown>, task: TaskProcess | null): ContainerInfo {
    const labels = (container['labels'] as Record<string, string> | undefined) ?? {};
    const id = String(container['id'] ?? '');
    const state = stateOf(task);
    // `Process.exit_status` is a plain uint32, so it decodes to 0 for a
    // running task. Only a stopped task has an exit code worth reporting.
    const exitCode = state === 'dead' && task ? Number(task.exit_status ?? 0) : undefined;
    const digest = labels[specLabel];
    return {
      name: id,
      id,
      state,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(digest === undefined ? {} : { digest }),
    };
  }

  async function create(
    spec: ContainerSpec,
    labels: Readonly<Record<string, string>>,
  ): Promise<ContainerInfo> {
    const { parent, config } = await imageFor(spec.image);
    // The snapshot is the container's writable rootfs. containerd does not
    // make one for you, and Tasks.Create has nothing to mount without it.
    await connection.call(SNAPSHOTS, 'Prepare', { snapshotter, key: spec.name, parent, labels: {} });
    const ociSpec: OciSpec = buildSpec({
      id: spec.name,
      namespace: connection.namespace,
      ...(config ? { image: config } : {}),
      ...(spec.command ? { command: spec.command } : {}),
      ...(spec.env ? { env: spec.env } : {}),
    });
    const response = await connection.call<{ container?: Record<string, unknown> }>(CONTAINERS, 'Create', {
      container: {
        id: spec.name,
        image: spec.image,
        labels: { ...labels },
        runtime: { name: runtime },
        spec: packJson(OCI_SPEC_TYPE_URL, ociSpec),
        snapshotter,
        snapshot_key: spec.name,
      },
    });
    return infoOf(response.container ?? { id: spec.name, labels }, null);
  }

  async function start(name: string): Promise<void> {
    // A stopped container keeps its record and its snapshot; only the task is
    // gone. So START is create-task + start-task, not create-container.
    const existing = await taskOf(name);
    if (existing?.status === 'RUNNING') return;
    if (existing) await connection.call(TASKS, 'Delete', { container_id: name }).catch(ignoreNotFound);
    await connection.call(TASKS, 'Create', {
      container_id: name,
      rootfs: await mountsFor(name),
      stdin: '',
      stdout: '',
      stderr: '',
      terminal: false,
    });
    await connection.call(TASKS, 'Start', { container_id: name, exec_id: '' });
  }

  async function stop(name: string, stopOptions?: { timeoutMs?: number }): Promise<void> {
    const task = await taskOf(name);
    if (!task || task.status === 'STOPPED' || task.status === 'CREATED') return;
    await connection.call(TASKS, 'Kill', { container_id: name, exec_id: '', signal: 15, all: false });
    const deadline = Date.now() + (stopOptions?.timeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      const current = await taskOf(name);
      if (!current || current.status === 'STOPPED') return;
      await sleep(25);
    }
    await connection
      .call(TASKS, 'Kill', { container_id: name, exec_id: '', signal: 9, all: false })
      .catch(ignoreNotFound);
  }

  async function remove(name: string): Promise<void> {
    await stop(name).catch(ignoreNotFound);
    await connection.call(TASKS, 'Delete', { container_id: name }).catch(ignoreNotFound);
    await connection.call(CONTAINERS, 'Delete', { id: name }).catch(ignoreNotFound);
    // The snapshot outlives the container record; nothing else removes it.
    await connection.call(SNAPSHOTS, 'Remove', { snapshotter, key: name }).catch(ignoreNotFound);
  }

  return {
    kind: 'grpc',
    capabilities: { pull: false, networks: false, publish: false, exec: true },
    create,
    start,
    stop,
    remove,

    async inspect(name) {
      try {
        const response = await connection.call<{ container?: Record<string, unknown> }>(CONTAINERS, 'Get', {
          id: name,
        });
        if (!response.container) return null;
        return infoOf(response.container, await taskOf(name));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async list() {
      // containerd's own filter syntax, evaluated server-side. This is what
      // prune() needs and what the watcher's initial sync reads.
      const response = await connection.call<{ containers?: Record<string, unknown>[] }>(CONTAINERS, 'List', {
        filters: [`labels."${managedLabel}"=="true"`],
      });
      const tasks = await connection.call<{ tasks?: TaskProcess[] }>(TASKS, 'List', { filter: '' });
      const byId = new Map((tasks.tasks ?? []).map((task) => [String(task.id ?? ''), task]));
      return (response.containers ?? []).map((container) =>
        infoOf(container, byId.get(String(container['id'] ?? '')) ?? null),
      );
    },

    async exec(name, argv) {
      const execId = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // Empty stdio is not an omission: a process with no stdio paths gets
      // /dev/null from the shim (cmd/containerd-shim-runc-v2/process/io.go),
      // and a readiness probe only needs the exit code.
      await connection.call(TASKS, 'Exec', {
        container_id: name,
        exec_id: execId,
        stdin: '',
        stdout: '',
        stderr: '',
        terminal: false,
        spec: packJson(OCI_PROCESS_TYPE_URL, {
          args: [...argv],
          cwd: '/',
          env: [],
          terminal: false,
          user: { uid: 0, gid: 0 },
        }),
      });
      await connection.call(TASKS, 'Start', { container_id: name, exec_id: execId });
      const waited = await connection.call<{ exit_status?: number }>(TASKS, 'Wait', {
        container_id: name,
        exec_id: execId,
      });
      await connection
        .call(TASKS, 'DeleteProcess', { container_id: name, exec_id: execId })
        .catch(ignoreNotFound);
      return { code: Number(waited.exit_status ?? 0), stdout: '', stderr: '' };
    },

    async *events(signal) {
      const stream = connection.stream<Envelope>(
        EVENTS,
        'Subscribe',
        { filters: namespaceFilter(connection.namespace) },
        signal,
      );
      for await (const envelope of stream) {
        const row = envelopeToEventRow(envelope);
        if (!row) continue;
        const event = interpret(row);
        if (event) yield event;
      }
    },

    createNetwork() {
      return Promise.reject(unsupported('networks'));
    },
    inspectNetwork() {
      return Promise.reject(unsupported('networks'));
    },
    listNetworks() {
      return Promise.reject(unsupported('networks'));
    },
    removeNetwork() {
      return Promise.reject(unsupported('networks'));
    },

    close() {
      connection.close();
      return Promise.resolve();
    },
  };
}

/**
 * The same translation `interpretEvent` does, minus the id-to-name lookup: on
 * containerd the id *is* the name, because the driver creates the container
 * with `id: spec.name`. The watcher's `index` map and its `inspect` fallback
 * exist only because nerdctl invents its own 64-hex ids.
 */
export function interpret(row: EventRow): StatusEvent | null {
  const body = (typeof row.Event === 'object' && row.Event !== null ? row.Event : {}) as Record<
    string,
    unknown
  >;
  const name = row.ID;
  if (!name) return null;
  switch (row.Topic) {
    case '/tasks/start':
      return { kind: 'set', name, state: 'running' };
    case '/tasks/exit':
      if (body['id'] !== undefined && body['id'] !== body['container_id']) return null;
      return { kind: 'set', name, state: 'dead', exitCode: Number(body['exit_status'] ?? 0) };
    case '/containers/delete':
      return { kind: 'remove', name };
    default:
      return null;
  }
}

function stateOf(task: TaskProcess | null): ContainerState {
  if (!task) return 'dead'; // A container record with no task is not running.
  switch (task.status) {
    case 'RUNNING':
    case 'PAUSED':
    case 'PAUSING':
      return 'running';
    case 'CREATED':
    case 'STOPPED':
      return 'dead';
    default:
      return 'unknown';
  }
}

function defaultResolveImage(snapshotter: string): GrpcDriverOptions['resolveImage'] & object {
  const label = `${SNAPSHOT_REF_LABEL_PREFIX}${snapshotter}`;
  return (name, image) => {
    const labels = (image['labels'] as Record<string, string> | undefined) ?? {};
    const parent = labels[label];
    if (!parent) {
      throw new Error(
        `image ${name}: no ${label}; either it is not unpacked for ${snapshotter}, or the chain id has to be read from its config blob in the content store`,
      );
    }
    return { parent };
  };
}

function unsupported(what: string): Error {
  return new Error(
    `the gRPC driver cannot do ${what}: containerd has no such API (see docs/grpc-design.md section 4)`,
  );
}

function ignoreNotFound(error: unknown): void {
  if (!isNotFound(error)) throw error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
