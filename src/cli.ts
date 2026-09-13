#!/usr/bin/env node
/**
 * fiber-servo CLI.
 *
 *   fiber-servo plan app.tsx           print the ops the tree would produce, without a runtime
 *   fiber-servo up   app.tsx           run the tree on containerd until Ctrl-C
 *   fiber-servo up   app.tsx --watch   ...and re-evaluate the file whenever it is saved
 *
 * `app.tsx` default-exports an element or a component. The file is the
 * source of truth. `apply` asks the running session to re-evaluate it.
 */
import { watch } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { listenSession, requestApply, sessionAddress, type ApplyResult } from './control.js';
import { loadElement } from './load.js';
import { createSession } from './session.js';
export { loadElement } from './load.js';
import { formatOp } from './ops.js';
import { containerd } from './runtime/containerd/index.js';
import { dummy } from './runtime/dummy.js';
import { serve, type Runtime } from './serve.js';
import type { ContainerStatus } from './status.js';

const USAGE = `usage:
  fiber-servo plan <app.tsx>                       print the ops, execute nothing
  fiber-servo apply <app.tsx>                      re-evaluate the running session
  fiber-servo up   <app.tsx> [--watch] [--runtime containerd|dummy]
                             [--namespace n] [--address sock] [--quiet]

<app.tsx> must default-export a React element or a component.
--watch re-evaluates the file on save and reconciles the difference.`;

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
      else if (
        !['watch', 'quiet', 'help'].includes(key!) &&
        argv[i + 1] !== undefined &&
        !argv[i + 1]!.startsWith('--')
      )
        flags[key!] = argv[++i]!;
      else flags[key!] = true;
    } else positional.push(arg);
  }
  return { command: positional[0], file: positional[1], flags };
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

export async function main(argv: readonly string[]): Promise<number> {
  const { command, file, flags } = parseArgs(argv);
  if (!command || !file || flags['help']) {
    console.log(USAGE);
    return command ? 1 : 0;
  }
  if (!['plan', 'up', 'apply'].includes(command)) {
    console.error(`fiber-servo: unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }
  const canonicalFile = await realpath(resolve(file));
  const printResult = (result: ApplyResult): number => {
    for (const op of result.ops) console.log(op);
    for (const error of result.errors) console.error(`!! ${error}`);
    console.log(
      result.ok
        ? `Applied (${result.ops.length} ops); readiness may still be pending.`
        : 'Apply failed; runtime changes are not rolled back.',
    );
    return result.ok ? 0 : 1;
  };
  if (command === 'apply') return printResult(await requestApply(canonicalFile));
  const quiet = flags['quiet'] === true;
  const stamp = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

  if (command === 'plan') {
    const served = serve(await loadElement(canonicalFile), {
      runtime: dummy({ log: (l) => console.log(l) }),
    });
    await served.root.settle();
    return 0;
  }

  if (command === 'up') {
    const session = createSession(
      {
        runtime: pickRuntime(flags, quiet ? () => {} : stamp),
        log: quiet ? () => {} : stamp,
        onError: (e) => stamp(`!! ${e.message}`),
        onOps: (ops) => {
          for (const op of ops) stamp(`op ${formatOp(op)}`);
        },
      },
      () => loadElement(canonicalFile),
    );
    const served = session.served;
    let closeControl: () => Promise<void>;
    try {
      // Claim the endpoint before evaluating the app or touching its resources.
      closeControl = await listenSession(canonicalFile, () => session.apply());
    } catch (e) {
      await session.stop();
      throw new Error(
        `Cannot start session at ${sessionAddress(canonicalFile)}: ${String(e)}. Another up may own it. On Unix, remove a stale socket only after confirming its owner has exited.`,
      );
    }
    const printStatus = statusPrinter(stamp);
    if (!quiet) served.status.subscribe(() => printStatus(served.status.entries()));

    let unwatch = () => {};
    let exitCode = 0;
    await new Promise<void>((done) => {
      let shuttingDown = false;
      const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        unwatch();
        stamp('stopping');
        // Reject new evaluations immediately; drain accepted ones before teardown.
        const stopping = session.stop();
        Promise.all([closeControl(), stopping]).then(
          () => {
            process.removeListener('SIGINT', shutdown);
            process.removeListener('SIGTERM', shutdown);
            done();
          },
          (e: unknown) => {
            exitCode = 1;
            stamp(`!! ${String(e)}`);
            done();
          },
        );
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      void session.apply().then(
        (result) => {
          if (!result.ok) {
            for (const error of result.errors) stamp(`!! ${error}`);
            exitCode = 1;
            shutdown();
            return;
          }
          if (shuttingDown) return;
          stamp(`session ready ${canonicalFile}`);
          if (flags['watch'] === true) {
            unwatch = watchFile(canonicalFile, () => {
              void session.apply().then(
                (result) => {
                  stamp(`reloaded ${file}`);
                  for (const error of result.errors) stamp(`!! ${error}`);
                },
                (error: unknown) => stamp(`!! ${String(error)}`),
              );
            });
            stamp(`watching ${file}`);
          }
        },
        (error: unknown) => {
          stamp(`!! ${String(error)}`);
          exitCode = 1;
          shutdown();
        },
      );
    });
    return exitCode;
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
