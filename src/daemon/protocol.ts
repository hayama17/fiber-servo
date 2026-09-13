/**
 * The daemon's wire format: newline-delimited JSON, in both directions.
 *
 * A request is one JSON object and a newline. The reply is a stream of JSON
 * lines and ends with `done`, after which the daemon closes the connection.
 * NDJSON needs no dependency and no length prefix, and it is readable with
 * `nc` when something goes wrong.
 *
 * What crosses the socket is a *file path*, never a serialized tree: the
 * daemon imports and evaluates the file itself, so it stays a host for
 * evaluations rather than a store of specs (decision 20).
 */
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import type { ContainerState } from '../status.js';

/** Mount `file`, or re-render the root already holding it so React diffs the change. */
export interface ApplyRequest {
  cmd: 'apply';
  /** Absolute path. The client resolves it: the daemon's cwd is its own. */
  file: string;
  /** Have the daemon watch the file and re-render on save. Never disarms; `delete` does. */
  watch?: boolean;
}

/** Unmount the root holding `file` and forget it. */
export interface DeleteRequest {
  cmd: 'delete';
  file: string;
}

export interface ListRequest {
  cmd: 'list';
}

export interface PingRequest {
  cmd: 'ping';
}

export type DaemonRequest = ApplyRequest | DeleteRequest | ListRequest | PingRequest;

/** One applied app, identified by the resolved path of the file that defines it. */
export interface AppInfo {
  id: string;
  watching: boolean;
  containers: readonly string[];
  networks: readonly string[];
}

/** A line the daemon or its runtime logged. */
export interface LogResponse {
  type: 'log';
  line: string;
}

/** One op a commit produced, already formatted by `formatOp`. */
export interface OpResponse {
  type: 'op';
  line: string;
  /** The app whose root emitted it. */
  app?: string;
}

export interface StatusResponse {
  type: 'status';
  id: string;
  state: ContainerState;
  ready?: boolean;
  exitCode?: number;
  reason?: string;
}

export interface ErrorResponse {
  type: 'error';
  message: string;
}

/** Always the last line, then the daemon closes. `ok` is the client's exit code. */
export interface DoneResponse {
  type: 'done';
  ok: boolean;
  /** `apply` and `delete`: the app they acted on. */
  id?: string;
  /** `list`: every applied app. `apply` and `delete`: the one they acted on. */
  apps?: readonly AppInfo[];
  /** `ping`: the daemon's process id. */
  pid?: number;
  /** Why, when `ok` is false. */
  message?: string;
}

export type DaemonResponse = LogResponse | OpResponse | StatusResponse | ErrorResponse | DoneResponse;

/** One message as a frame: JSON on a single line, terminated by a newline. */
export function encodeMessage(message: DaemonRequest | DaemonResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * A stateful decoder: feed it whatever the socket delivers, get back the
 * complete messages so far. Chunk boundaries have nothing to do with message
 * boundaries, so a line split across two chunks is held until its newline
 * arrives, and several messages in one chunk all come back at once. The
 * `StringDecoder` does the same for multi-byte characters split across chunks.
 */
export function createMessageDecoder<T>(): (chunk: Uint8Array | string) => T[] {
  const characters = new StringDecoder('utf8');
  let rest = '';
  return (chunk) => {
    rest +=
      typeof chunk === 'string'
        ? chunk
        : characters.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const messages: T[] = [];
    for (let newline = rest.indexOf('\n'); newline !== -1; newline = rest.indexOf('\n')) {
      const line = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (line.trim() !== '') messages.push(JSON.parse(line) as T);
    }
    return messages;
  };
}

/**
 * Validate a decoded request. The socket is a trust boundary only in the
 * weakest sense (it is the host's own filesystem), but a typo should be an
 * error line rather than an exception inside the registry.
 */
export function parseRequest(value: unknown): DaemonRequest {
  if (typeof value !== 'object' || value === null) throw new Error('fiber-servo: request must be an object');
  const { cmd, file, watch } = value as Record<string, unknown>;
  if (cmd === 'list' || cmd === 'ping') return { cmd };
  if (cmd === 'apply' || cmd === 'delete') {
    if (typeof file !== 'string' || file === '') throw new Error(`fiber-servo: ${cmd} needs a "file"`);
    return cmd === 'apply' ? { cmd, file, watch: watch === true } : { cmd, file };
  }
  throw new Error(`fiber-servo: unknown command "${String(cmd)}"`);
}

/**
 * Where the daemon listens unless `--socket` says otherwise. `XDG_RUNTIME_DIR`
 * is per-user and cleaned on logout; `/run` is the fallback for a daemon
 * started as root, where that variable is usually unset.
 */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['FIBER_SERVO_SOCK'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const runtimeDir = env['XDG_RUNTIME_DIR'];
  if (runtimeDir !== undefined && runtimeDir !== '') return join(runtimeDir, 'fiber-servo.sock');
  return '/run/fiber-servo.sock';
}
