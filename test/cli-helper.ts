import { execFile, spawn } from 'node:child_process';
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

/** Run the built CLI as a real child process and give tests a way to wait on its output. */
export function cli(args: string[]) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', cliWrapper, ...args], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr!.on('data', (data: Buffer) => {
    output += data.toString();
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  return {
    child,
    exited,
    output: () => output,
    async until(text: string, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!output.includes(text)) {
        if (child.exitCode !== null) throw new Error(`Missing ${text}\n${output}`);
        if (Date.now() > deadline) throw new Error(`Missing ${text}\n${output}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    async stop() {
      if (child.exitCode === null && child.connected) child.send('stop');
      await exited;
    },
  };
}
