/**
 * `tsc` emits JavaScript and nothing else, so the vendored `.proto` files —
 * which are loaded at runtime, not compiled — have to be carried into `dist`
 * by hand. Without this the published package throws on its first containerd
 * read, and only then.
 */
import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'src', 'runtime', 'containerd', 'protos');
const to = join(root, 'dist', 'runtime', 'containerd', 'protos');
await cp(from, to, { recursive: true });
console.log(`copied protos -> ${to}`);
