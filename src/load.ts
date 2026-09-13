/**
 * Loading a program from a file, and noticing when its definition changes.
 *
 * Shared by `up` and by the daemon. It lives on its own so that the daemon,
 * which the library entry point exports, does not have to import the CLI.
 */
import { watch } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement, isValidElement, type ReactNode } from 'react';

let tsxRegistered = false;
// Two reloads inside the same millisecond must not share a cache entry, which
// a timestamp alone cannot promise; a daemon reloads far more often than `up`.
let loads = 0;

/**
 * Import the app file and return its element. `fresh` bypasses the module
 * cache for the entry file so a reload sees the saved version; modules it
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
