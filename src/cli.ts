#!/usr/bin/env node
/**
 * fiber-servo CLI.
 *
 *   fiber-servo plan app.tsx           print the actions the tree would produce, without a runtime
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
import { formatAction } from './planner.js';
import { containerd } from './runtime/containerd/index.js';
import { memory } from './runtime/memory.js';
import { serve } from './serve.js';
import type { ObservedPod, ObservedState, RuntimeFactory } from './runtime/types.js';

const USAGE = `usage:
  fiber-servo plan <app.tsx>                       print the actions, execute nothing
  fiber-servo apply <app.tsx>                      re-evaluate the running session
  fiber-servo up   <app.tsx> [--watch] [--runtime containerd|memory]
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

/**
 * Prints observed state as it changes. This is the only place the CLI shows
 * reality rather than intent, and it is deliberately separate from the action
 * log above it: one is what we asked for, the other is what happened.
 */
function podPrinter(log: (line: string) => void): (state: ObservedState) => void {
  const seen = new Map<string, ObservedPod>();
  return (state) => {
    for (const [name, pod] of state.pods) {
      if (seen.get(name) === pod) continue;
      seen.set(name, pod);
      const detail = pod.containers
        .map(
          (c) =>
            `${c.name}=${c.phase}${c.ready ? '/ready' : ''}${c.exitCode !== undefined ? ` exit ${c.exitCode}` : ''}`,
        )
        .join(' ');
      log(`pod ${name} ${pod.phase}${pod.ip ? ` ip=${pod.ip}` : ''}${detail ? ` [${detail}]` : ''}`);
    }
    for (const name of [...seen.keys()]) if (!state.pods.has(name)) seen.delete(name);
  };
}

function pickRuntime(flags: Args['flags'], log: (line: string) => void): RuntimeFactory {
  const which = flags['runtime'] ?? 'containerd';
  if (which === 'memory') return memory({ log });
  if (which === 'containerd') {
    return containerd({
      namespace: typeof flags['namespace'] === 'string' ? flags['namespace'] : undefined,
      address: typeof flags['address'] === 'string' ? flags['address'] : undefined,
    });
  }
  throw new Error(`fiber-servo: unknown --runtime "${String(which)}"; use containerd or memory`);
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
        ? `Applied (${result.ops.length} actions); readiness may still be pending.`
        : 'Apply failed; runtime changes are not rolled back.',
    );
    return result.ok ? 0 : 1;
  };
  if (command === 'apply') return printResult(await requestApply(canonicalFile));
  const quiet = flags['quiet'] === true;
  const stamp = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

  if (command === 'plan') {
    // Planning runs the whole control plane against the in-memory runtime, which
    // always succeeds. That is what makes gated subtrees appear: <Ready on="db">
    // only declares its children once the db Pod is observed running, and here
    // it is observed running because the memory runtime says so. Nothing
    // touches containerd.
    const actions: string[] = [];
    const served = serve(await loadElement(canonicalFile), {
      runtime: memory(),
      onActions: (batch) => {
        for (const action of batch) actions.push(formatAction(action));
      },
    });
    // React commits and control-loop passes feed each other, so quiescence is
    // "two rounds in a row produced no new action".
    let quiet = 0;
    for (let i = 0; i < 50 && quiet < 2; i++) {
      const before = actions.length;
      await served.root.settle();
      await served.idle();
      quiet = actions.length === before ? quiet + 1 : 0;
    }
    for (const line of actions) console.log(line);
    return 0;
  }

  if (command === 'up') {
    const session = createSession(
      {
        runtime: pickRuntime(flags, quiet ? () => {} : stamp),
        log: quiet ? () => {} : stamp,
        // No `onActions` here: `serve` already logs each action through `log`,
        // and printing from both channels doubles every line.
        onError: (e) => stamp(`!! ${e.message}`),
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
    const printPods = podPrinter(stamp);
    if (!quiet) served.observed.subscribe(() => printPods(served.observed.snapshot()));

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
