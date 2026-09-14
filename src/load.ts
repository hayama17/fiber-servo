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
  // `src/` and `dist/` are two builds of this same library, and an app can only
  // share the one this process is actually running. The *other* one is the trap
  // guarded against below. Note this is deliberately just those two directories
  // and not the package root: an app file living inside the repo may import its
  // own local modules freely, and those must still be bundled normally.
  const siblingBuilds = ['src', 'dist'].map((d) => join(dirname(library), d)).filter((d) => d !== library);
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
        /**
         * Keep exactly one copy of fiber-servo in the process.
         *
         * The app file is bundled, so a relative import reaching back into
         * this library would be bundled *with* it — giving the app its own
         * second copy of every module, including the React context that
         * carries observed state. Nothing errors when that happens: the tree
         * simply reads an observed store that no runtime ever writes to, so
         * `<Ready>` never opens and half the app silently fails to appear.
         *
         * Imports landing inside the running library are marked external, so
         * both sides share one module. Imports landing inside a *different*
         * build of it — `../src/...` while running from `dist/`, which is
         * what an in-repo example does — cannot be shared, because the path
         * the app asks for is not the one this process loaded. That is the
         * silent-failure case, so it is turned into a loud one.
         */
        name: 'shared-fiber-servo',
        setup(builder) {
          builder.onResolve({ filter: /^\./ }, (args) => {
            if (args.kind === 'entry-point') return;
            const target = resolve(args.resolveDir, args.path);
            if (target.startsWith(library + sep)) return { path: target, external: true };
            if (siblingBuilds.some((d) => target === d || target.startsWith(d + sep))) {
              return {
                errors: [
                  {
                    text:
                      `${args.path} reaches into another build of fiber-servo (${target}) while this ` +
                      `process is running from ${library}. Bundling it would load a second copy of the ` +
                      `library and the app would half-work in confusing ways. Import "fiber-servo" ` +
                      `instead, or run the CLI from the same build the app imports ` +
                      `(\`npx tsx src/cli.ts\` for a file importing ../src).`,
                  },
                ],
              };
            }
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
