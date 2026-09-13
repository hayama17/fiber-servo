/** Bundle local app modules afresh while sharing installed packages and fiber-servo itself. */
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement, isValidElement, type ReactNode } from 'react';

export async function loadElement(file: string, _fresh = false): Promise<ReactNode> {
  const absolute = resolve(file);
  const library = dirname(fileURLToPath(import.meta.url));
  const output = join(dirname(absolute), `.fiber-servo-${randomUUID()}.mjs`);
  const built = await build({
    entryPoints: [absolute],
    bundle: true,
    write: false,
    outfile: output,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'shared-fiber-servo',
        setup(builder) {
          builder.onResolve({ filter: /^\./ }, (args) => {
            if (args.kind === 'entry-point') return;
            const target = resolve(args.resolveDir, args.path);
            if (target.startsWith(library + sep)) return { path: target, external: true };
          });
        },
      },
    ],
  });
  try {
    await writeFile(output, built.outputFiles![0]!.contents, { flag: 'wx', mode: 0o600 });
    const mod = (await import(pathToFileURL(output).href)) as { default?: unknown };
    if (isValidElement(mod.default)) return mod.default;
    if (typeof mod.default === 'function') return createElement(mod.default as () => ReactNode);
    throw new Error(`fiber-servo: ${file} must default-export a React element or a component`);
  } finally {
    await unlink(output).catch(() => {});
  }
}
