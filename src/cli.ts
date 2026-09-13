#!/usr/bin/env node
/**
 * fiber-servo CLI.
 *
 *   fiber-servo plan app.tsx           print the ops the tree would produce, without a runtime
 *   fiber-servo up   app.tsx           run the tree on containerd until Ctrl-C
 *   fiber-servo up   app.tsx --watch   ...and re-evaluate the file whenever it is saved
 *
 * `app.tsx` default-exports an element or a component. The file is the
 * source of truth: there is no server to apply to (see docs/decisions.md 18).
 */
import { watch } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement, isValidElement, type ReactNode } from 'react';
import { formatOp } from './ops.js';
import { containerd } from './runtime/containerd/index.js';
import { dummy } from './runtime/dummy.js';
import { serve, type Runtime } from './serve.js';
import type { ContainerStatus } from './status.js';

const USAGE = `usage:
  fiber-servo plan <app.tsx>                       print the ops, execute nothing
  fiber-servo up   <app.tsx> [--watch] [--runtime containerd|dummy]
                             [--namespace n] [--address sock] [--quiet]
                             [--no-prune]

<app.tsx> must default-export a React element or a component.
--watch re-evaluates the file on save and reconciles the difference.
--no-prune keeps managed containers the file no longer declares.`;

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
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) flags[key!] = argv[++i]!;
      else flags[key!] = true;
    } else positional.push(arg);
  }
  return { command: positional[0], file: positional[1], flags };
}

let tsxRegistered = false;

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
  const url = pathToFileURL(resolve(file)).href + (fresh ? `?t=${Date.now()}` : '');
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

export async function main(argv: readonly string[]): Promise<number> {
  const { command, file, flags } = parseArgs(argv);
  if (!command || !file || flags['help']) {
    console.log(USAGE);
    return command ? 1 : 0;
  }
  const element = await loadElement(file);
  const quiet = flags['quiet'] === true;
  const stamp = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

  if (command === 'plan') {
    const served = serve(element, { runtime: dummy({ log: (l) => console.log(l) }) });
    await served.root.settle();
    return 0;
  }

  if (command === 'up') {
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
        ? watchFile(file, () => {
            loadElement(file, true).then(
              (next) => {
                stamp(`reloaded ${file}`);
                try {
                  served.root.render(next);
                } catch (e) {
                  stamp(`!! ${e instanceof Error ? e.message : String(e)}`);
                }
              },
              (e: unknown) =>
                stamp(
                  `!! ${file}: ${e instanceof Error ? e.message : String(e)} (keeping the previous tree)`,
                ),
            );
          })
        : () => {};
    if (flags['watch'] === true) stamp(`watching ${file}`);

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
