/**
 * The daemon: one process, one runtime, N React roots.
 *
 * `serve()` is one evaluation of one program. The daemon is a host for
 * several of them at once: one nerdctl instance, one status store, one
 * executor queue, one event watcher and one readiness prober, shared by every
 * applied app because container names are global on the host.
 *
 * It holds no desired state of its own. `apply` names a file; the daemon
 * imports it and keeps the *evaluation* -- the live component tree -- which
 * is what lets a new observation produce a new intention (decision 21).
 */
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { loadElement, watchFile } from '../load.js';
import { formatOp } from '../ops.js';
import { createRoot, type Root } from '../reconciler.js';
import type { Runtime } from '../serve.js';
import { createStatusStore, type StatusStore } from '../status.js';
import {
  createMessageDecoder,
  defaultSocketPath,
  encodeMessage,
  parseRequest,
  type AppInfo,
  type DaemonResponse,
} from './protocol.js';

/** Where a request's output goes while a client is attached. */
type Emit = (message: DaemonResponse) => void;

export interface AppRegistryOptions {
  /** The single runtime every app shares. */
  runtime: Runtime;
  log?: (line: string) => void;
  onError?: (error: Error) => void;
  /** Delete managed resources no applied app declares. Default `true`. */
  prune?: boolean;
}

export interface ApplyOptions {
  /** Watch the file and re-render on save. Idempotent; only `delete` disarms it. */
  watch?: boolean;
  /** Receives the reply stream for the duration of the call. */
  emit?: Emit;
}

export interface AppRegistry {
  /** Shared by every app: one observation of one host. */
  readonly status: StatusStore;
  /** Mount `file`, or re-render the root already holding it so React diffs the change. */
  apply(file: string, options?: ApplyOptions): Promise<AppInfo>;
  /** Unmount the root holding `file`; resolves with what it was holding. */
  remove(file: string, options?: { emit?: Emit }): Promise<AppInfo>;
  list(): AppInfo[];
  /** Unmount everything, drain the runtime, stop the watcher. */
  close(): Promise<void>;
}

interface App {
  readonly id: string;
  readonly root: Root;
  unwatch?: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAppRegistry(options: AppRegistryOptions): AppRegistry {
  const status = createStatusStore();
  const apps = new Map<string, App>();
  const attached = new Set<Emit>();

  const broadcast = (message: DaemonResponse): void => {
    for (const emit of attached) emit(message);
  };
  const log = (line: string): void => {
    options.log?.(line);
    broadcast({ type: 'log', line });
  };
  // The daemon's own record of a request it just answered. Not broadcast: the
  // client learns the outcome from `done` and would print it twice.
  const note = (line: string): void => options.log?.(line);
  const onError = (error: Error): void => {
    options.onError?.(error);
    broadcast({ type: 'error', message: error.message });
  };

  const handle = options.runtime({ status, log, onError });
  const stopping = new AbortController();
  const watching = handle.watch ? handle.watch(stopping.signal).catch(onError) : Promise.resolve();

  // One queue for every mutation. Two applies must not interleave their
  // renders: they share the store, the executor and the prune keep set.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function attach(emit: Emit | undefined): () => void {
    if (emit === undefined) return () => {};
    attached.add(emit);
    return () => attached.delete(emit);
  }

  /**
   * Stream this app's container statuses to the client while it waits. The
   * store is shared, so it is filtered to what this root declares.
   */
  function streamStatus(app: App, emit: Emit): () => void {
    const seen = new Map<string, number>();
    const flush = (): void => {
      const declared = new Set(app.root.liveIds('container'));
      for (const [id, snapshot] of status.entries()) {
        if (!declared.has(id) || seen.get(id) === snapshot.seq) continue;
        seen.set(id, snapshot.seq);
        emit({
          type: 'status',
          id,
          state: snapshot.state,
          ready: snapshot.ready,
          exitCode: snapshot.exitCode,
          reason: snapshot.reason,
        });
      }
    };
    const unsubscribe = status.subscribe(flush);
    return () => {
      flush(); // statuses that arrived in the same tick as the last commit
      unsubscribe();
    };
  }

  function createApp(id: string): App {
    const app: App = {
      id,
      root: createRoot({
        status,
        sink: (ops) => {
          for (const op of ops) broadcast({ type: 'op', line: formatOp(op), app: id });
          handle.sink(ops);
        },
      }),
    };
    apps.set(id, app);
    return app;
  }

  function infoOf(app: App): AppInfo {
    return {
      id: app.id,
      watching: app.unwatch !== undefined,
      containers: app.root.liveIds('container'),
      networks: app.root.liveIds('network'),
    };
  }

  /**
   * INTEGRATION POINT for orphan pruning (decision 20). The keep set is the
   * union of every applied root's live ids, because container names are global
   * on the host: one app's containers are another app's orphans otherwise. The
   * moment is the same as `serve()`'s -- after `handle.synced` (the watcher's
   * first `ps -a`, which opens the gates of adopted containers) and after every
   * root has settled -- except that here "every root" means all of them.
   */
  async function pruneOrphans(): Promise<void> {
    if (options.prune === false) return;
    if (typeof handle.prune !== 'function') return;
    await handle.synced;
    for (const app of [...apps.values()]) await app.root.settle();
    const removed = await handle.prune({
      containers: [...new Set([...apps.values()].flatMap((app) => app.root.liveIds('container')))],
      networks: [...new Set([...apps.values()].flatMap((app) => app.root.liveIds('network')))],
    });
    if (removed.length > 0) log(`pruned ${removed.join(' ')}`);
  }

  async function render(app: App, fresh: boolean): Promise<void> {
    const element = await loadElement(app.id, fresh);
    app.root.render(element);
    await app.root.settle();
    await handle.idle?.();
  }

  function startWatching(app: App): void {
    if (app.unwatch !== undefined) return;
    app.unwatch = watchFile(app.id, () => {
      void serialize(async () => {
        if (apps.get(app.id) !== app) return; // deleted while the save was in flight
        try {
          log(`reloaded ${app.id}`);
          await render(app, true);
          await pruneOrphans();
        } catch (error) {
          // A file that does not evaluate is not a new desired state; the
          // previous evaluation stays live and keeps healing what it declared.
          onError(new Error(`${app.id}: ${messageOf(error)} (keeping the previous tree)`));
        }
      });
    });
    log(`watching ${app.id}`);
  }

  return {
    status,

    apply(file, applyOptions = {}) {
      const id = resolve(file);
      return serialize(async () => {
        const detach = attach(applyOptions.emit);
        const known = apps.get(id);
        const app = known ?? createApp(id);
        const stopStatus = applyOptions.emit ? streamStatus(app, applyOptions.emit) : undefined;
        try {
          // Always bypass the module cache: a daemon outlives many edits, and
          // an apply must evaluate the program as the file defines it now.
          await render(app, true);
          note(known === undefined ? `applied ${id}` : `re-applied ${id}`);
          if (applyOptions.watch === true) startWatching(app);
          await pruneOrphans();
          return infoOf(app);
        } catch (error) {
          if (known === undefined) {
            // A first apply that failed leaves nothing worth keeping; unmount
            // so a partial commit does not survive as an app nobody declared.
            app.root.unmount();
            apps.delete(id);
            await handle.idle?.();
          }
          throw error;
        } finally {
          stopStatus?.();
          detach();
        }
      });
    },

    remove(file, removeOptions = {}) {
      const id = resolve(file);
      return serialize(async () => {
        const app = apps.get(id);
        if (app === undefined) throw new Error(`fiber-servo: ${id} is not applied`);
        const detach = attach(removeOptions.emit);
        try {
          app.unwatch?.();
          app.unwatch = undefined;
          const info = infoOf(app); // what it held, before the tree is torn down
          apps.delete(id);
          app.root.unmount();
          await handle.idle?.();
          note(`deleted ${id}`);
          await pruneOrphans();
          return info;
        } finally {
          detach();
        }
      });
    },

    list() {
      return [...apps.values()].map(infoOf);
    },

    close() {
      return serialize(async () => {
        for (const app of apps.values()) {
          app.unwatch?.();
          app.root.unmount();
        }
        apps.clear();
        await handle.idle?.();
        stopping.abort();
        await watching;
      });
    },
  };
}

export interface DaemonOptions extends AppRegistryOptions {
  /** Default: `$FIBER_SERVO_SOCK`, `$XDG_RUNTIME_DIR/fiber-servo.sock`, `/run/fiber-servo.sock`. */
  socketPath?: string;
}

export interface Daemon {
  readonly socketPath: string;
  readonly registry: AppRegistry;
  /** Unmount every app, drain the runtime, stop the watcher, unlink the socket. */
  close(): Promise<void>;
}

/** True when something accepts a connection on `path` right now. */
export function isListening(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((settle) => {
    const socket = connect(path);
    const finish = (alive: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      settle(alive);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * A unix socket file outlives the process that made it, so its presence says
 * nothing. Connecting is the only reliable test: refused means the file is
 * stale and may be removed, accepted means a daemon is there and this one
 * must not steal its path.
 */
export async function claimSocketPath(path: string): Promise<void> {
  if (!existsSync(path)) return;
  if (await isListening(path)) {
    throw new Error(`fiber-servo: a daemon is already listening on ${path}`);
  }
  await unlink(path);
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((settle, fail) => {
    server.once('error', fail);
    server.listen(path, () => {
      server.removeListener('error', fail);
      settle();
    });
  });
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const socketPath = options.socketPath ?? defaultSocketPath();
  await claimSocketPath(socketPath);
  const registry = createAppRegistry(options);
  const sockets = new Set<Socket>();

  async function answer(raw: unknown, send: Emit): Promise<void> {
    try {
      const request = parseRequest(raw);
      switch (request.cmd) {
        case 'ping':
          send({ type: 'done', ok: true, pid: process.pid });
          return;
        case 'list':
          send({ type: 'done', ok: true, apps: registry.list() });
          return;
        case 'apply': {
          const info = await registry.apply(request.file, { watch: request.watch, emit: send });
          send({ type: 'done', ok: true, id: info.id, apps: [info] });
          return;
        }
        case 'delete': {
          const info = await registry.remove(request.file, { emit: send });
          send({ type: 'done', ok: true, id: info.id, apps: [info] });
          return;
        }
      }
    } catch (error) {
      // `done` carries the reason; a separate `error` line would only be a
      // second copy of it. `error` is for what happens *during* a request.
      send({ type: 'done', ok: false, message: messageOf(error) });
    }
  }

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('close', () => sockets.delete(socket));
    // A client that hangs up mid-reply is normal (Ctrl-C); it is not an error
    // the daemon should carry.
    socket.on('error', () => socket.destroy());

    const decode = createMessageDecoder<unknown>();
    let answering = false;
    const send: Emit = (message) => {
      if (socket.writable) socket.write(encodeMessage(message));
    };
    socket.on('data', (chunk) => {
      let requests: unknown[];
      try {
        requests = decode(chunk);
      } catch (error) {
        send({ type: 'done', ok: false, message: messageOf(error) });
        socket.end();
        return;
      }
      for (const raw of requests) {
        if (answering) continue; // one request per connection; the rest is noise
        answering = true;
        void answer(raw, send).finally(() => socket.end());
      }
    });
  });

  await listen(server, socketPath);
  options.log?.(`listening on ${socketPath}`);

  return {
    socketPath,
    registry,
    async close() {
      server.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await registry.close();
      // `server.close()` unlinks the path itself; this covers the case where
      // it did not get that far.
      await unlink(socketPath).catch(() => undefined);
    },
  };
}

/** Start a daemon and run until SIGINT or SIGTERM, then shut down in order. */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  const daemon = await startDaemon(options);
  await new Promise<void>((done) => {
    const shutdown = (): void => {
      options.log?.('stopping');
      daemon.close().then(done, (error: unknown) => {
        options.onError?.(new Error(messageOf(error)));
        done();
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
