import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
/** Exercise the shipped CLI, without npx, shell shims, or platform-specific pathnames. */
export async function buildCli() {
  await promisify(execFile)(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
    { cwd: projectRoot },
  );
}
// IPC is only a test transport for a graceful signal on Windows, where kill(SIGINT) terminates immediately.
export const cliWrapper = `process.on('message', () => process.emit('SIGINT'));
  const { main } = await import('./dist/cli.js');
  main(process.argv.slice(1)).then(code => process.exit(code), e => { console.error(e); process.exit(1); });`;
