/**
 * The transport: one gRPC connection to containerd's unix socket, with the
 * namespace header on every call.
 *
 * Two things are easy to get wrong and both are proved by the tests:
 *
 * 1. The target string. grpc-js understands the `unix:` scheme, so
 *    containerd's own default address, `/run/containerd/containerd.sock`,
 *    becomes `unix:///run/containerd/containerd.sock` (three slashes: the
 *    third is the leading slash of the absolute path). Credentials are
 *    `createInsecure()`; the socket's file permissions are the access
 *    control, which is why talking to containerd needs root or membership of
 *    the socket's group, exactly like nerdctl.
 *
 * 2. The namespace. containerd has no default namespace at the API level: it
 *    reads it from a gRPC metadata header on every single call, and a call
 *    without it fails. The key is `containerd-namespace`
 *    (pkg/namespaces/grpc.go, `GRPCHeader`; the ttrpc variant used to talk to
 *    shims is `containerd-namespace-ttrpc`). nerdctl's `--namespace` is
 *    nothing but this header.
 */
import * as grpc from '@grpc/grpc-js';
import { serviceClientConstructor } from './protos.js';

/** containerd's namespace metadata key. Required on every call. */
export const NAMESPACE_HEADER = 'containerd-namespace';

/** containerd's default socket and namespace. */
export const DEFAULT_ADDRESS = '/run/containerd/containerd.sock';
export const DEFAULT_NAMESPACE = 'default';

/** `/run/containerd/containerd.sock` -> `unix:///run/containerd/containerd.sock`. */
export function socketTarget(address: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) return address;
  if (address.startsWith('unix:')) return address;
  return address.startsWith('/') ? `unix://${address}` : `unix:${address}`;
}

export function namespaceMetadata(namespace: string): grpc.Metadata {
  const metadata = new grpc.Metadata();
  metadata.set(NAMESPACE_HEADER, namespace);
  return metadata;
}

type Callback = (error: grpc.ServiceError | null, response?: unknown) => void;
type AnyClient = grpc.Client & Record<string, (...args: never[]) => unknown>;

export interface ContainerdConnectionOptions {
  address?: string;
  namespace?: string;
  /** Per-call deadline in ms. Default 10_000. Streams are never deadlined. */
  timeoutMs?: number;
}

export interface ContainerdConnection {
  readonly namespace: string;
  readonly target: string;
  /** One unary call. Rejects with a `grpc.ServiceError` carrying `code`. */
  call<T = Record<string, unknown>>(service: string, method: string, request: object): Promise<T>;
  /** One server-streaming call, as an async iterable that ends when `signal` aborts. */
  stream<T = Record<string, unknown>>(
    service: string,
    method: string,
    request: object,
    signal?: AbortSignal,
  ): AsyncIterable<T>;
  close(): void;
}

export function connect(options: ContainerdConnectionOptions = {}): ContainerdConnection {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const target = socketTarget(options.address ?? DEFAULT_ADDRESS);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const clients = new Map<string, AnyClient>();

  function clientFor(service: string): AnyClient {
    let client = clients.get(service);
    if (!client) {
      const Ctor = serviceClientConstructor(service);
      client = new Ctor(target, grpc.credentials.createInsecure()) as AnyClient;
      clients.set(service, client);
    }
    return client;
  }

  return {
    namespace,
    target,
    call<T>(service: string, method: string, request: object): Promise<T> {
      const client = clientFor(service);
      const fn = client[method];
      if (typeof fn !== 'function') throw new Error(`${service} has no method ${method}`);
      return new Promise<T>((resolve, reject) => {
        const deadline = new Date(Date.now() + timeoutMs);
        const done: Callback = (error, response) => (error ? reject(error) : resolve(response as T));
        (fn as unknown as (r: object, m: grpc.Metadata, o: object, c: Callback) => void).call(
          client,
          request,
          namespaceMetadata(namespace),
          { deadline },
          done,
        );
      });
    },
    async *stream<T>(service: string, method: string, request: object, signal?: AbortSignal) {
      const client = clientFor(service);
      const fn = client[method];
      if (typeof fn !== 'function') throw new Error(`${service} has no method ${method}`);
      const call = (fn as unknown as (r: object, m: grpc.Metadata) => grpc.ClientReadableStream<T>).call(
        client,
        request,
        namespaceMetadata(namespace),
      );
      const cancel = (): void => call.cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        for await (const message of call) yield message as T;
      } catch (error) {
        // A cancelled stream is how this loop is meant to end.
        if (!isCancelled(error)) throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
    close() {
      for (const client of clients.values()) client.close();
      clients.clear();
    },
  };
}

export function isCancelled(error: unknown): boolean {
  return isServiceError(error) && error.code === grpc.status.CANCELLED;
}

export function isNotFound(error: unknown): boolean {
  return isServiceError(error) && error.code === grpc.status.NOT_FOUND;
}

export function isAlreadyExists(error: unknown): boolean {
  return isServiceError(error) && error.code === grpc.status.ALREADY_EXISTS;
}

function isServiceError(error: unknown): error is grpc.ServiceError {
  return typeof error === 'object' && error !== null && 'code' in error;
}
