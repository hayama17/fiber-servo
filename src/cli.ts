#!/usr/bin/env node
/**
 * fiber-servo CLI.
 *
 *   fiber-servo plan app.tsx   print the ops the tree would produce, without a runtime
 *   fiber-servo up   app.tsx   run the tree on containerd until Ctrl-C
 *
 * `app.tsx` default-exports an element or a component.
 */
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement, isValidElement, type ReactNode } from 'react';
import { formatOp } from './ops.js';
import { containerd } from './runtime/containerd/index.js';
import { dummy } from './runtime/dummy.js';
import { serve } from './serve.js';
import type { ContainerStatus } from './status.js';

const USAGE = `usage:
  fiber-servo plan <app.tsx>                       print the ops, execute nothing
  fiber-servo up   <app.tsx> [--namespace n] [--address sock] [--quiet]

<app.tsx> must default-export a React element or a component.`;

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

export async function loadElement(file: string): Promise<ReactNode> {
  if (/^\.[cm]?tsx?$/.test(extname(file))) {
    try {
      const { register } = await import('tsx/esm/api');
      register();
    } catch {
      throw new Error('fiber-servo: loading TypeScript needs the "tsx" package (npm install tsx)');
    }
  }
  const mod = (await import(pathToFileURL(resolve(file)).href)) as { default?: unknown };
  const exported = mod.default;
  if (isValidElement(exported)) return exported;
  if (typeof exported === 'function') return createElement(exported as () => ReactNode);
  throw new Error(`fiber-servo: ${file} must default-export a React element or a component`);
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
      runtime: containerd({
        namespace: typeof flags['namespace'] === 'string' ? flags['namespace'] : undefined,
        address: typeof flags['address'] === 'string' ? flags['address'] : undefined,
      }),
      log: quiet ? () => {} : stamp,
      onError: (e) => stamp(`!! ${e.message}`),
      onOps: (ops) => {
        for (const op of ops) stamp(`op ${formatOp(op)}`);
      },
    });
    const printStatus = statusPrinter(stamp);
    if (!quiet) served.status.subscribe(() => printStatus(served.status.entries()));

    await new Promise<void>((done) => {
      const shutdown = () => {
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
