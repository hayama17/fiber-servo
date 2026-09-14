/**
 * containerd's own API, read directly.
 *
 * This is the read half of the adapter. Writes still go through the `nerdctl`
 * CLI (see `nerdctl.ts` and decision 21), because nerdctl carries a great deal
 * of behaviour containerd does not — image resolution, CNI attachment, port
 * publishing — that would have to be reimplemented to leave it. Reads carry
 * none of that: they are pure state, and going to the source has three
 * concrete advantages over shelling out to `nerdctl inspect`:
 *
 *   - **No text to parse.** `nerdctl inspect --format '{{...}}'` answers with
 *     a string that has to be split and interpreted, and the format strings
 *     are a private contract with a CLI that is free to change its wording.
 *     This is not hypothetical: `removeNetwork` shipped broken precisely
 *     because a message was guessed rather than observed.
 *   - **No process per read.** A `Containers.List` round trip measures ~20ms
 *     against a local socket; spawning `nerdctl` costs several times that,
 *     and a reconcile pass does one read per Pod.
 *   - **Typed events.** `Events.Subscribe` delivers structured events with a
 *     container id and an exit status in fields, replacing a line-oriented
 *     parse of `nerdctl events` output — the single most fragile thing in the
 *     old adapter.
 *
 * What it deliberately does NOT cover: **networks**. containerd has no concept
 * of one. nerdctl's networks are CNI configuration files on disk and creating
 * or deleting one produces no containerd event at all. `cni.ts` reads those
 * directly; this file would have nothing to say about them.
 */
import { credentials, loadPackageDefinition, Metadata, type ClientReadableStream } from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { Root } from 'protobufjs';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the vendored `.proto` files live, in both `src/` and `dist/`. */
const PROTO_DIR = fileURLToPath(new URL('./protos', import.meta.url));

export const DEFAULT_ADDRESS = '/run/containerd/containerd.sock';
export const DEFAULT_NAMESPACE = 'default';

// ---- what a read gives back -------------------------------------------------

/** A container as containerd holds it: an id, an image, and labels. Nothing about networking. */
export interface ApiContainer {
  readonly id: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * A task is the *running process* of a container. The distinction matters:
 * a container can exist with no task (created, or exited and not removed),
 * which is exactly the "exited" case the planner acts on.
 */
export type ApiTaskStatus = 'unknown' | 'created' | 'running' | 'stopped' | 'paused' | 'pausing';

export interface ApiTask {
  /** The container's id; a task is named after the container it runs. */
  readonly id: string;
  readonly status: ApiTaskStatus;
  readonly exitStatus?: number;
}

/** A containerd event, reduced to the fields this project acts on. */
export interface ApiEvent {
  readonly topic: string;
  /** The event message name, e.g. `containerd.events.TaskExit`. */
  readonly type: string;
  readonly containerId?: string;
  readonly exitStatus?: number;
}

export interface ContainerdApi {
  listContainers(): Promise<ApiContainer[]>;
  getContainer(id: string): Promise<ApiContainer | undefined>;
  listTasks(): Promise<ApiTask[]>;
  /** Stream events until the returned function is called. */
  subscribe(onEvent: (event: ApiEvent) => void, onError?: (error: Error) => void): () => void;
  close(): void;
}

export interface ContainerdApiOptions {
  /** Path to containerd's socket. Default `/run/containerd/containerd.sock`. */
  address?: string;
  /** containerd namespace. Default `default`. */
  namespace?: string;
}

// ---- proto loading ----------------------------------------------------------

interface GrpcClient {
  close(): void;
  [method: string]: unknown;
}

type ServiceCtor = new (address: string, creds: ReturnType<typeof credentials.createInsecure>) => GrpcClient;

function loadServices(): {
  Containers: ServiceCtor;
  Tasks: ServiceCtor;
  Events: ServiceCtor;
} {
  const definition = protoLoader.loadSync(
    [
      'services/containers/v1/containers.proto',
      'services/tasks/v1/tasks.proto',
      'services/events/v1/events.proto',
    ],
    { includeDirs: [PROTO_DIR], keepCase: true, longs: String, enums: String, defaults: true, oneofs: true },
  );
  const pkg = loadPackageDefinition(definition) as unknown as {
    containerd: {
      services: {
        containers: { v1: { Containers: ServiceCtor } };
        tasks: { v1: { Tasks: ServiceCtor } };
        events: { v1: { Events: ServiceCtor } };
      };
    };
  };
  return {
    Containers: pkg.containerd.services.containers.v1.Containers,
    Tasks: pkg.containerd.services.tasks.v1.Tasks,
    Events: pkg.containerd.services.events.v1.Events,
  };
}

/**
 * A protobufjs root over the event payload types, used to decode the
 * `google.protobuf.Any` a subscription delivers. gRPC hands the payload back
 * as opaque bytes plus a type url; only the message definitions can turn that
 * into fields.
 */
function loadEventTypes(): Root {
  const root = new Root();
  // protobufjs answers most `google/protobuf/*` imports from types compiled
  // into the library, but a few (descriptor.proto, which the containerd
  // fieldpath option needs) ship only as files inside the package. Rewriting
  // every import to our own directory would hide both, so those are left for
  // protobufjs to resolve and only containerd's own imports are redirected.
  const protobufjsRoot = dirname(createRequire(import.meta.url).resolve('protobufjs/package.json'));
  root.resolvePath = (_origin, target) => {
    if (target.startsWith('google/protobuf/')) {
      const bundled = join(protobufjsRoot, target);
      return existsSync(bundled) ? bundled : target;
    }
    return join(PROTO_DIR, target);
  };
  const files = readdirSync(join(PROTO_DIR, 'events')).filter((f) => f.endsWith('.proto'));
  root.loadSync(
    files.map((f) => join('events', f)),
    { keepCase: true },
  );
  return root;
}

// ---- the client -------------------------------------------------------------

export function createContainerdApi(options: ContainerdApiOptions = {}): ContainerdApi {
  const address = `unix://${options.address ?? DEFAULT_ADDRESS}`;
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const services = loadServices();
  const insecure = credentials.createInsecure();

  const containers = new services.Containers(address, insecure);
  const tasks = new services.Tasks(address, insecure);
  const events = new services.Events(address, insecure);

  // containerd scopes everything by namespace, and it travels as metadata
  // rather than as a request field. Forgetting it does not error: it reads
  // the wrong namespace and returns nothing, which looks exactly like an
  // empty machine.
  const metadata = new Metadata();
  metadata.set('containerd-namespace', namespace);

  const eventTypes = loadEventTypes();

  function unary<T>(client: GrpcClient, method: string, request: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const fn = client[method] as (
        req: object,
        md: Metadata,
        cb: (error: Error | null, response: T) => void,
      ) => void;
      fn.call(client, request, metadata, (error, response) =>
        error ? reject(describe(error, method)) : resolve(response),
      );
    });
  }

  /** containerd's gRPC errors say little on their own; say which call failed. */
  function describe(error: Error, method: string): Error {
    return new Error(`fiber-servo: containerd ${method} failed: ${error.message}`);
  }

  function toContainer(raw: { id: string; image: string; labels?: Record<string, string> }): ApiContainer {
    return { id: raw.id, image: raw.image, labels: raw.labels ?? {} };
  }

  /**
   * containerd reports a stopped task's exit code, but reports `0` for one
   * that never ran. Only a stopped task's is meaningful, so the rest are left
   * undefined rather than reported as a clean exit.
   */
  function toTask(raw: { id: string; status: string; exit_status?: number }): ApiTask {
    const status = raw.status.toLowerCase() as ApiTaskStatus;
    return {
      id: raw.id,
      status,
      ...(status === 'stopped' ? { exitStatus: raw.exit_status ?? 0 } : {}),
    };
  }

  return {
    async listContainers() {
      const res = await unary<{
        containers: { id: string; image: string; labels?: Record<string, string> }[];
      }>(containers, 'List', {});
      return res.containers.map(toContainer);
    },

    async getContainer(id) {
      try {
        const res = await unary<{
          container: { id: string; image: string; labels?: Record<string, string> };
        }>(containers, 'Get', { id });
        return toContainer(res.container);
      } catch (error) {
        // NotFound is an answer, not a failure: "it is not there" is exactly
        // what the caller asked. Anything else is a real error.
        if (/NOT_FOUND|not found/i.test(String(error))) return undefined;
        throw error;
      }
    },

    async listTasks() {
      const res = await unary<{ tasks: { id: string; status: string; exit_status?: number }[] }>(
        tasks,
        'List',
        {},
      );
      return res.tasks.map(toTask);
    },

    subscribe(onEvent, onError) {
      const stream = events.Subscribe as unknown as (
        req: object,
        md: Metadata,
      ) => ClientReadableStream<{ topic: string; event?: { type_url?: string; value?: Uint8Array } }>;
      const call = stream.call(events, { filters: [] }, metadata);
      call.on('data', (envelope) => {
        const typeUrl = envelope.event?.type_url ?? '';
        const type = typeUrl.split('/').pop() ?? '';
        let containerId: string | undefined;
        let exitStatus: number | undefined;
        if (envelope.event?.value && type) {
          try {
            const decoded = eventTypes.lookupType(type).decode(envelope.event.value) as unknown as {
              container_id?: string;
              exit_status?: number;
            };
            containerId = decoded.container_id;
            exitStatus = decoded.exit_status;
          } catch {
            // An event whose payload we cannot decode is still worth
            // reporting by topic: the watcher treats an unrecognised event as
            // a reason to resync, which is correct but slower. Dropping it
            // silently would not be.
          }
        }
        onEvent({ topic: envelope.topic, type, containerId, exitStatus });
      });
      call.on('error', (error: Error) => onError?.(error));
      return () => call.cancel();
    },

    close() {
      containers.close();
      tasks.close();
      events.close();
    },
  };
}
