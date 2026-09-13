#!/usr/bin/env node
/**
 * fiber-servo CLI.
 *
 *   fiber-servo plan   app.tsx           print the ops the tree would produce, without a runtime
 *   fiber-servo up     app.tsx           run the tree on containerd until Ctrl-C
 *   fiber-servo up     app.tsx --watch   ...and re-evaluate the file whenever it is saved
 *
 *   fiber-servo daemon                   host evaluations; listen on one unix socket
 *   fiber-servo apply  app.tsx           have the daemon evaluate that program
 *   fiber-servo delete app.tsx           unmount just that app
 *
 * `app.tsx` default-exports an element or a component. There is no desired
 * state to apply into a store: the program is what is sent, and what it
 * evaluates to is what runs (see docs/decisions.md 18 and 21).
 */
import { watch } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement, isValidElement, type ReactNode } from 'react';
import { sendRequest } from './daemon/client.js';
import type { DaemonRequest, DaemonResponse, DoneResponse } from './daemon/protocol.js';
import { runDaemon } from './daemon/server.js';
import { formatOp } from './ops.js';
import { containerd } from './runtime/containerd/index.js';
import { dummy } from './runtime/dummy.js';
import { serve, type Runtime } from './serve.js';
import type { ContainerStatus } from './status.js';

const USAGE = `usage:
  fiber-servo plan   <app.tsx>                     print the ops, execute nothing
  fiber-servo up     <app.tsx> [--watch] [--runtime containerd|dummy]
                               [--namespace n] [--address sock] [--quiet]
                               [--no-prune]
  fiber-servo daemon [--socket path] [--runtime containerd|dummy]
                     [--namespace n] [--address sock] [--quiet] [--no-prune]
  fiber-servo apply  <app.tsx> [--watch] [--socket path]
  fiber-servo delete <app.tsx> [--socket path]
  fiber-servo list | ping      [--socket path]

<app.tsx> must default-export a React element or a component.
--watch re-evaluates the file on save and reconciles the difference; under
  \`apply\` the daemon does the watching, and \`delete\` stops it.
--no-prune keeps managed containers no applied program declares.
The daemon's socket is $FIBER_SERVO_SOCK, else $XDG_RUNTIME_DIR/fiber-servo.sock,
else /run/fiber-servo.sock.`;

/** Commands that take no `<app.tsx>`. */
const FILELESS = new Set(['daemon', 'list', 'ping']);

/** Flags that are switches, so they never swallow the next word as a value. */
const SWITCHES = new Set(['watch', 'quiet', 'help', 'no-prune']);

interface Args {
  command: string | undefined;
  file: string | undefined;
  flags: Record<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Args {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) flags[key!] = inline;
      else if (SWITCHES.has(key!)) flags[key!] = true;
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) flags[key!] = argv[++i]!;
      else flags[key!] = true;
    } else positional.push(arg);
  }
  return { command: positional[0], file: positional[1], flags };
}

let tsxRegistered = false;
// Two reloads inside the same millisecond must not share a cache entry, which
// a timestamp alone cannot promise; a daemon reloads far more often than `up`.
let loads = 0;

/**
 * Import the app file and return its element. `fresh` bypasses the module
 * cache for the entry file so `--watch` sees the saved version; modules it
 * imports stay cached, which is why an app is best kept in one file.
 */
export async function loadElement(file: string, fresh = false): Promise<ReactNode> {
  if (!tsxRegistered && /^\.[cm]?tsx?$/.test(extname(file))) {
    try {
      const { register } = await import('tsx/esm/api');
      register();
      tsxRegistered = true;
    } catch {
      throw new Error('fiber-servo: loading TypeScript needs the "tsx" package (npm install tsx)');
    }
  }
  const url = pathToFileURL(resolve(file)).href + (fresh ? `?t=${Date.now()}-${++loads}` : '');
  const mod = (await import(url)) as { default?: unknown };
  const exported = mod.default;
  if (isValidElement(exported)) return exported;
  if (typeof exported === 'function') return createElement(exported as () => ReactNode);
  throw new Error(`fiber-servo: ${file} must default-export a React element or a component`);
}

/** Call `onChange` after the file is saved (debounced; survives editors that save by rename). */
export function watchFile(file: string, onChange: () => void, debounceMs = 100): () => void {
  const abs = resolve(file);
  const name = basename(abs);
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(dirname(abs), (_event, changed) => {
    if (changed !== null && changed !== name) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

function statusPrinter(log: (line: string) => void): (entries: ReadonlyMap<string, ContainerStatus>) => void {
  const seen = new Map<string, ContainerStatus>();
  return (entries) => {
    for (const [name, s] of entries) {
      if (seen.get(name) === s) continue;
      seen.set(name, s);
      const extra = [
        s.exitCode !== undefined ? `exit ${s.exitCode}` : '',
        s.ready ? 'ready' : '',
        s.reason ? s.reason : '',
      ]
        .filter(Boolean)
        .join(', ');
      log(`status ${name} ${s.state}${extra ? ` (${extra})` : ''}`);
    }
    for (const name of [...seen.keys()]) if (!entries.has(name)) seen.delete(name);
  };
}

function pickRuntime(flags: Args['flags'], log: (line: string) => void): Runtime {
  const which = flags['runtime'] ?? 'containerd';
  if (which === 'dummy') return dummy({ log });
  if (which === 'containerd') {
    return containerd({
      namespace: typeof flags['namespace'] === 'string' ? flags['namespace'] : undefined,
      address: typeof flags['address'] === 'string' ? flags['address'] : undefined,
    });
  }
  throw new Error(`fiber-servo: unknown --runtime "${String(which)}"; use containerd or dummy`);
}

function requireFile(file: string | undefined): string {
  if (file === undefined) throw new Error(`fiber-servo: this command needs an <app.tsx>\n\n${USAGE}`);
  return file;
}

/** Print one line of a daemon's reply the way `up` prints its own. */
function printMessage(message: DaemonResponse, out: (line: string) => void): void {
  switch (message.type) {
    case 'log':
      out(message.line);
      break;
    case 'op':
      out(`op ${message.line}`);
      break;
    case 'status': {
      const extra = [
        message.exitCode !== undefined ? `exit ${message.exitCode}` : '',
        message.ready === true ? 'ready' : '',
        message.reason ?? '',
      ]
        .filter(Boolean)
        .join(', ');
      out(`status ${message.id} ${message.state}${extra ? ` (${extra})` : ''}`);
      break;
    }
    case 'error':
      out(`!! ${message.message}`);
      break;
    case 'done':
      break;
  }
}

function printDone(command: string, done: DoneResponse, out: (line: string) => void): void {
  if (!done.ok) {
    console.error(done.message ?? `fiber-servo: ${command} failed`);
    return;
  }
  if (command === 'ping') out(`pong (pid ${String(done.pid)})`);
  else if (command === 'list') {
    if (!done.apps || done.apps.length === 0) out('no apps applied');
    for (const app of done.apps ?? [])
      out(
        `${app.id}${app.watching ? ' (watching)' : ''} containers=[${app.containers.join(',')}] networks=[${app.networks.join(',')}]`,
      );
  } else out(`${command === 'apply' ? 'applied' : 'deleted'} ${String(done.id)}`);
}

export async function main(argv: readonly string[]): Promise<number> {
  const { command, file, flags } = parseArgs(argv);
  if (!command || flags['help'] || (file === undefined && !FILELESS.has(command))) {
    console.log(USAGE);
    return command ? 1 : 0;
  }
  const quiet = flags['quiet'] === true;
  const stamp = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);
  const socketPath = typeof flags['socket'] === 'string' ? flags['socket'] : undefined;

  if (command === 'plan') {
    const served = serve(await loadElement(requireFile(file)), {
      runtime: dummy({ log: (l) => console.log(l) }),
    });
    await served.root.settle();
    return 0;
  }

  if (command === 'up') {
    const appFile = requireFile(file);
    const element = await loadElement(appFile);
    const served = serve(element, {
      runtime: pickRuntime(flags, quiet ? () => {} : stamp),
      prune: flags['no-prune'] !== true,
      log: quiet ? () => {} : stamp,
      onError: (e) => stamp(`!! ${e.message}`),
      onOps: (ops) => {
        for (const op of ops) stamp(`op ${formatOp(op)}`);
      },
    });
    const printStatus = statusPrinter(stamp);
    if (!quiet) served.status.subscribe(() => printStatus(served.status.entries()));

    const unwatch =
      flags['watch'] === true
        ? watchFile(appFile, () => {
            loadElement(appFile, true).then(
              (next) => {
                stamp(`reloaded ${appFile}`);
                try {
                  served.root.render(next);
                } catch (e) {
                  stamp(`!! ${e instanceof Error ? e.message : String(e)}`);
                }
              },
              (e: unknown) =>
                stamp(
                  `!! ${appFile}: ${e instanceof Error ? e.message : String(e)} (keeping the previous tree)`,
                ),
            );
          })
        : () => {};
    if (flags['watch'] === true) stamp(`watching ${appFile}`);

    await new Promise<void>((done) => {
      const shutdown = () => {
        unwatch();
        stamp('stopping');
        served.stop().then(done, (e: unknown) => {
          stamp(`!! ${String(e)}`);
          done();
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
    return 0;
  }

  if (command === 'daemon') {
    await runDaemon({
      runtime: pickRuntime(flags, quiet ? () => {} : stamp),
      prune: flags['no-prune'] !== true,
      socketPath,
      log: quiet ? () => {} : stamp,
      onError: (e) => stamp(`!! ${e.message}`),
    });
    return 0;
  }

  if (command === 'apply' || command === 'delete' || command === 'list' || command === 'ping') {
    // The path is resolved here, against the client's cwd: the daemon has its
    // own, and what identifies an app is the absolute path of its program.
    const request: DaemonRequest =
      command === 'apply'
        ? { cmd: 'apply', file: resolve(requireFile(file)), watch: flags['watch'] === true }
        : command === 'delete'
          ? { cmd: 'delete', file: resolve(requireFile(file)) }
          : { cmd: command };
    const done = await sendRequest(request, {
      socketPath,
      onMessage: (message) => {
        if (!quiet) printMessage(message, stamp);
      },
    });
    printDone(command, done, stamp);
    return done.ok ? 0 : 1;
  }

  console.error(`fiber-servo: unknown command "${command}"\n\n${USAGE}`);
  return 1;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
