/**
 * The only place that spawns processes.
 *
 * containerd is driven through nerdctl, a thin CLI over containerd's gRPC
 * API that also brings CNI networking and port publishing (phase 2). The
 * executor and the event watcher only see this interface, so tests inject a
 * fake and assert on argv, and a direct gRPC client can replace this file
 * later without touching either of them.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Nerdctl {
  /** Run a nerdctl subcommand to completion. Never rejects on a non-zero exit. */
  exec(args: readonly string[]): Promise<ExecResult>;
  /** Run a long-lived subcommand and yield its stdout line by line until it exits or `signal` aborts. */
  stream(args: readonly string[], signal?: AbortSignal): AsyncIterable<string>;
}

export interface NerdctlOptions {
  /** Binary to invoke. Default `nerdctl`. */
  bin?: string;
  /** containerd namespace. Default `default`. */
  namespace?: string;
  /** containerd socket, e.g. `/run/containerd/containerd.sock`. Default: nerdctl's own. */
  address?: string;
}

/** Label that marks every resource this reconciler owns (sandboxes, members, networks alike). */
export const MANAGED_LABEL = 'fiber-servo.managed';
/** Label carrying `digest()` of the spec a resource was created from (decision 10: adoption by spec digest). */
export const SPEC_LABEL = 'fiber-servo.spec';
/**
 * Which Pod a container belongs to. Set on the sandbox *and* every member, so
 * both are one `ps --filter label=fiber-servo.pod=<name>` away from either
 * other -- this is how `inspect()` and `removePod` find "everything that
 * makes up this Pod" without keeping their own membership list.
 */
export const POD_LABEL = 'fiber-servo.pod';
/** A member's name *within* its Pod. Absent on the sandbox, which has no such name. */
export const CONTAINER_LABEL = 'fiber-servo.container';
/** `infra` for the sandbox container, `member` for everything else. */
export const ROLE_LABEL = 'fiber-servo.role';
/**
 * The resource's own spec -- `PodSpec` on the sandbox, `ContainerSpec` on a
 * member -- percent-encoded JSON (escaping survives `nerdctl ps`'s
 * comma-joined `Labels` column, which a raw JSON object would not). This is
 * how `ObservedPod.spec` and the readiness prober's schedule both survive a
 * fiber-servo restart: neither exists anywhere else in containerd. See the
 * "recorded spec" section in `runtime.ts` for why resources are *not* read
 * from this label even though `ContainerSpec.resources` is JSON inside it.
 */
export const SPEC_JSON_LABEL = 'fiber-servo.spec-json';

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
    async *stream(args, signal) {
      const child = spawn(bin, [...globalArgs, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
      const abort = () => child.kill();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        for await (const line of createInterface({ input: child.stdout })) yield line;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (child.exitCode === null) child.kill();
      }
    },
  };
}
