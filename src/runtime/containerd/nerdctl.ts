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

export interface ExecOptions {
  /**
   * Kill the process after this many milliseconds and report it as a failure.
   *
   * There is one caller that needs this and it is not an optimisation: a
   * readiness probe is by definition run against a container that may be
   * unwell, and `nerdctl exec` into a wedged container never returns. Without
   * a bound, that one stuck child holds the container's exec lock, so the
   * `compose rm` and `compose down` that teardown issues block behind it and
   * Ctrl-C never completes. Found by running it, not by reading it.
   */
  timeoutMs?: number;
}

export interface Nerdctl {
  /** Run a nerdctl subcommand to completion. Never rejects on a non-zero exit. */
  exec(args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
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
    exec(args, opts = {}) {
      const bounded = opts.timeoutMs !== undefined && opts.timeoutMs > 0;
      return new Promise((resolve, reject) => {
        const child = spawn(bin, [...globalArgs, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          // Its own process group, so a timeout can kill the whole tree.
          // `nerdctl compose exec` is itself a parent -- it runs `nerdctl
          // exec` -- and signalling only the top of that tree leaves the
          // grandchild alive holding the stdout pipe, so `close` never fires
          // and the timeout does nothing at all. Measured: without this the
          // bounded call still waited for the full sleep.
          detached: bounded,
        });
        let stdout = '';
        let stderr = '';
        let timer: ReturnType<typeof setTimeout> | undefined;
        let hardTimer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        /** Signal the whole group; an already-dead group is not an error. */
        const killGroup = (signal: NodeJS.Signals): void => {
          if (child.pid === undefined) return;
          try {
            process.kill(-child.pid, signal);
          } catch {
            /* already gone */
          }
        };
        if (bounded) {
          timer = setTimeout(() => {
            timedOut = true;
            killGroup('SIGTERM');
            // A process ignoring SIGTERM is exactly the case this exists for,
            // so do not take its word for it.
            hardTimer = setTimeout(() => killGroup('SIGKILL'), 1000);
          }, opts.timeoutMs);
        }
        const clear = (): void => {
          if (timer) clearTimeout(timer);
          if (hardTimer) clearTimeout(hardTimer);
        };
        child.on('error', (e) => {
          clear();
          reject(e);
        });
        child.on('close', (code) => {
          clear();
          if (timedOut) {
            resolve({
              code: -1,
              stdout,
              stderr: `${stderr}fiber-servo: killed after ${String(opts.timeoutMs)}ms`,
            });
            return;
          }
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },
  };
}
