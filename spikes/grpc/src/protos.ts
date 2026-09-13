/**
 * Loading the real containerd protos.
 *
 * The .proto files under ../protos are copied verbatim from the
 * `github.com/containerd/containerd/api` Go module, v1.11.1 (the API module
 * that ships with containerd 2.3.5), Apache-2.0. See ../protos/NOTICE.md.
 *
 * From api v1.8.0 on (containerd 2.x) the imports inside those files are
 * relative to the module root ("types/mount.proto"), so the module root is
 * the single include dir. containerd 1.7 spells the same imports
 * "github.com/containerd/containerd/api/types/mount.proto", which only
 * changes where the files have to sit on disk.
 *
 * google/protobuf/{any,empty,timestamp,field_mask,descriptor}.proto are the
 * only external imports and protobufjs (a dependency of @grpc/proto-loader)
 * bundles all five, so nothing else has to be vendored.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';

export const PROTO_DIR = fileURLToPath(new URL('../protos', import.meta.url));

/** Everything a lifecycle + events driver needs. Roots only; imports are followed. */
export const PROTO_FILES = [
  'services/containers/v1/containers.proto',
  'services/tasks/v1/tasks.proto',
  'services/events/v1/events.proto',
  'services/snapshots/v1/snapshots.proto',
  'services/images/v1/images.proto',
  'services/version/v1/version.proto',
  'events/task.proto',
  'events/container.proto',
] as const;

/**
 * `keepCase` matters: containerd's fields are snake_case (`container_id`,
 * `exit_status`) and `src/runtime/containerd/events.ts` reads them by those
 * names, because that is what nerdctl prints too.
 */
export const LOAD_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_DIR],
};

let cached: protoLoader.PackageDefinition | undefined;

/** The parsed protos. Cached: parsing 14 files takes ~30ms and never changes. */
export function packageDefinition(): protoLoader.PackageDefinition {
  cached ??= protoLoader.loadSync([...PROTO_FILES], LOAD_OPTIONS);
  return cached;
}

/** A grpc-js service definition by fully qualified name, e.g. `containerd.services.tasks.v1.Tasks`. */
export function serviceDefinition(fullName: string): grpc.ServiceDefinition {
  const entry = packageDefinition()[fullName];
  if (!entry || !isService(entry)) throw new Error(`${fullName} is not a service in the loaded protos`);
  return entry as unknown as grpc.ServiceDefinition;
}

/** A grpc-js client constructor for a service, e.g. `Containers`. */
export function serviceClientConstructor(fullName: string): grpc.ServiceClientConstructor {
  const pkg = grpc.loadPackageDefinition(packageDefinition());
  const ctor = fullName.split('.').reduce<unknown>((node, part) => {
    if (node && typeof node === 'object' && part in node) return (node as Record<string, unknown>)[part];
    return undefined;
  }, pkg);
  if (typeof ctor !== 'function') throw new Error(`${fullName} is not a service in the loaded protos`);
  return ctor as grpc.ServiceClientConstructor;
}

/**
 * The serializer pair for a message type, e.g. `containerd.events.TaskExit`.
 * This is how google.protobuf.Any payloads get packed and unpacked: proto-loader
 * gives every message a `serialize`/`deserialize`, and Any is just bytes plus a
 * type URL.
 */
export interface MessageType {
  serialize(value: object): Buffer;
  deserialize(bytes: Buffer): Record<string, unknown>;
}

export function messageType(fullName: string): MessageType {
  const entry = packageDefinition()[fullName];
  if (!entry || isService(entry)) throw new Error(`${fullName} is not a message in the loaded protos`);
  const type = entry as unknown as {
    serialize(value: object): Buffer;
    deserialize(bytes: Buffer): Record<string, unknown>;
  };
  return { serialize: (v) => type.serialize(v), deserialize: (b) => type.deserialize(b) };
}

function isService(entry: protoLoader.AnyDefinition): boolean {
  // A message definition carries `format`; a service is a map of method definitions.
  return !('format' in entry);
}
