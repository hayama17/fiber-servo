/**
 * The only place that spawns processes.
 *
 * `nerdctl compose` owns the whole write path now (decision: see `runtime.ts`'s
 * file doc): image pulling, network creation, running and removing containers.
 * This file is just the process-execution seam over it, kept separate so
 * tests inject a fake and assert on argv instead of on shelling out for real.
 * Nothing here parses a compose file or knows what `up`/`rm`/`down` mean --
 * that judgment lives in `runtime.ts`.
 */
import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Nerdctl {
  /** Run a nerdctl subcommand to completion. Never rejects on a non-zero exit. */
  exec(args: readonly string[]): Promise<ExecResult>;
}

export interface NerdctlOptions {
  /** Binary to invoke. Default `nerdctl`. */
  bin?: string;
  /** containerd namespace. Default `default`. */
  namespace?: string;
  /** containerd socket, e.g. `/run/containerd/containerd.sock`. Default: nerdctl's own. */
  address?: string;
}

export function createNerdctl(options: NerdctlOptions = {}): Nerdctl {
  const bin = options.bin ?? 'nerdctl';
  const globalArgs = [
    '--namespace',
    options.namespace ?? 'default',
    ...(options.address ? ['--address', options.address] : []),
  ];

  return {
    exec(args) {
      return new Promise((resolve, reject) => {
        const child = spawn(bin, [...globalArgs, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });
    },
  };
}
