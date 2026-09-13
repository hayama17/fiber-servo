/**
 * google.protobuf.Any, the containerd way.
 *
 * containerd puts three different kinds of payload in an `Any` and does not
 * use the canonical `type.googleapis.com/` prefix for any of them. The rules
 * come from github.com/containerd/typeurl/v2 (types.go):
 *
 *   - a protobuf message  -> type_url is the bare full name
 *                            ("containerd.events.TaskExit"), value is the
 *                            protobuf encoding;
 *   - a Go type registered with `typeurl.Register` -> type_url is the
 *     registered path and value is **JSON**. The OCI runtime spec is one of
 *     these: containerd registers it as
 *     "types.containerd.io/opencontainers/runtime-spec/1/Spec"
 *     (core/runtime/typeurl.go), so `Container.spec` is JSON bytes, not
 *     protobuf. A client that packs it as protobuf gets nowhere.
 *
 * @grpc/proto-loader does not pack or unpack Any at all: a field of that type
 * is `{ type_url, value }` with `value` a Buffer, in both directions. So this
 * file is all a JS client needs, and it is about twenty lines.
 */
import { messageType } from './protos.js';

export interface Any {
  type_url: string;
  value: Buffer;
}

/** Type URL of the OCI runtime spec, as containerd registers it. */
export const OCI_SPEC_TYPE_URL = 'types.containerd.io/opencontainers/runtime-spec/1/Spec';
/** Type URL of an OCI process, used by Tasks.Exec. */
export const OCI_PROCESS_TYPE_URL = 'types.containerd.io/opencontainers/runtime-spec/1/Process';

/** Pack a protobuf message: bare full name, protobuf bytes. */
export function packProto(fullName: string, message: object): Any {
  return { type_url: fullName, value: messageType(fullName).serialize(message) };
}

/** Unpack a protobuf `Any`. Returns null when the type is not one we loaded. */
export function unpackProto(any: Any | undefined): Record<string, unknown> | null {
  if (!any?.type_url) return null;
  const fullName = any.type_url.replace(/^type\.googleapis\.com\//, '');
  try {
    return messageType(fullName).deserialize(Buffer.from(any.value ?? []));
  } catch {
    return null;
  }
}

/** Pack a typeurl-registered Go type: registered path, JSON bytes. */
export function packJson(typeUrl: string, value: unknown): Any {
  return { type_url: typeUrl, value: Buffer.from(JSON.stringify(value), 'utf8') };
}

/** Unpack a typeurl-registered Go type. */
export function unpackJson<T>(any: Any | undefined): T | null {
  if (!any?.value?.length) return null;
  try {
    return JSON.parse(Buffer.from(any.value).toString('utf8')) as T;
  } catch {
    return null;
  }
}
