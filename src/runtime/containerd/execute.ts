/**
 * Executes ops against containerd (via nerdctl). This is the sink.
 *
 * Batches run strictly in order, one at a time, so a DELETE and a CREATE of
 * the same name from consecutive commits cannot interleave. The executor
 * writes to the status store only what it alone can observe: a CREATE or
 * START that containerd refused is reported as `dead` (with the reason), so
 * the tree retries with backoff. Lifecycle (start / exit) comes from the
 * event watcher, not from here.
 */
import { createHash } from 'node:crypto';
import type { ContainerSpec, Op, OpSink } from '../../ops.js';
import type { StatusStore } from '../../status.js';
import { MANAGED_LABEL, SPEC_LABEL, type ExecResult, type Nerdctl } from './nerdctl.js';

export interface ContainerdRuntimeOptions {
  nerdctl: Nerdctl;
  /** Receives `dead` for CREATE / START failures. Optional but recommended. */
  status?: StatusStore;
  /**
   * Maps a containerd id (64 hex) to its react4c name. Share it with the
   * event watcher so events for containers created here resolve without an
   * extra `inspect`.
   */
  index?: Map<string, string>;
  log?: (line: string) => void;
  onError?: (error: Error, op: Op) => void;
}

export interface ContainerdRuntime {
  sink: OpSink;
  /** Resolves once every batch received so far has been executed. */
  idle(): Promise<void>;
}

/** Stable digest of a spec; stored as a label so CREATE can recognise a container it already made. */
export function specDigest(spec: ContainerSpec): string {
  return createHash('sha256').update(canonical(spec)).digest('hex').slice(0, 32);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * argv for `nerdctl run` from a spec. Restarts are ours, so `--restart=no`.
 * `ports` are container-side metadata until networking (phase 2) decides
 * how they are published; they still take part in the digest.
 */
export function runArgs(spec: ContainerSpec): string[] {
  const args = [
    'run',
    '-d',
    '--name',
    spec.name,
    '--restart=no',
    '--pull=missing',
    '--label',
    `${MANAGED_LABEL}=true`,
    '--label',
    `${SPEC_LABEL}=${specDigest(spec)}`,
  ];
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push('-e', `${k}=${v}`);
  for (const [k, v] of Object.entries(spec.labels ?? {})) args.push('--label', `${k}=${v}`);
  args.push(spec.image, ...(spec.command ?? []));
  return args;
}

interface Inspected {
  id: string;
  running: boolean;
  digest: string | undefined;
}

export function createContainerdRuntime(options: ContainerdRuntimeOptions): ContainerdRuntime {
  const { nerdctl, status, index, log = () => {}, onError = (e) => console.error(e) } = options;
  /** Last spec we were asked to realise per name, so START can recreate a vanished container. */
  const specs = new Map<string, ContainerSpec>();
  let queue: Promise<void> = Promise.resolve();

  async function call(args: string[]): Promise<ExecResult> {
    log(`$ nerdctl ${args.join(' ')}`);
    return nerdctl.exec(args);
  }

  function fail(res: ExecResult, what: string): Error {
    return new Error(`nerdctl ${what} failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }

  async function inspect(name: string): Promise<Inspected | null> {
    const res = await call([
      'inspect',
      '--format',
      `{{.Id}} {{.State.Running}} {{index .Config.Labels "${SPEC_LABEL}"}}`,
      name,
    ]);
    if (res.code !== 0) return null;
    const [id = '', running = '', digest = ''] = res.stdout.trim().split(/\s+/);
    return { id, running: running === 'true', digest: digest || undefined };
  }

  async function run(spec: ContainerSpec): Promise<void> {
    const res = await call(runArgs(spec));
    if (res.code !== 0) throw fail(res, `run ${spec.name}`);
    const id = res.stdout.trim().split('\n').at(-1) ?? '';
    if (/^[0-9a-f]{12,64}$/.test(id)) index?.set(id, spec.name);
  }

  async function remove(name: string): Promise<void> {
    const res = await call(['rm', '-f', name]);
    // "no such container" is success for a delete.
    if (res.code !== 0 && !/no such|not found/i.test(res.stderr)) throw fail(res, `rm ${name}`);
  }

  async function create(spec: ContainerSpec): Promise<void> {
    specs.set(spec.name, spec);
    const existing = await inspect(spec.name);
    if (existing === null) return run(spec);
    if (existing.digest === specDigest(spec)) {
      // Adopt a container a previous process made from the same spec.
      index?.set(existing.id, spec.name);
      if (existing.running) return;
      const res = await call(['start', spec.name]);
      if (res.code !== 0) throw fail(res, `start ${spec.name}`);
      return;
    }
    await remove(spec.name);
    await run(spec);
  }

  async function start(name: string): Promise<void> {
    const res = await call(['start', name]);
    if (res.code === 0) return;
    const spec = specs.get(name);
    if (spec && (await inspect(name)) === null) return run(spec); // it vanished: recreate
    throw fail(res, `start ${name}`);
  }

  async function execute(op: Op): Promise<void> {
    switch (op.type) {
      case 'CREATE':
        return create(op.spec);
      case 'UPDATE':
        specs.set(op.id, op.next);
        await remove(op.id);
        return run(op.next);
      case 'START':
        return start(op.id);
      case 'DELETE':
        specs.delete(op.id);
        await remove(op.id);
        status?.remove(op.id);
        return;
    }
  }

  async function executeBatch(ops: readonly Op[]): Promise<void> {
    for (const op of ops) {
      try {
        await execute(op);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        onError(error, op);
        if (op.type === 'CREATE' || op.type === 'START' || op.type === 'UPDATE') {
          status?.set(op.id, 'dead', { reason: error.message });
        }
      }
    }
  }

  return {
    sink(ops) {
      const batch = [...ops];
      queue = queue.then(() => executeBatch(batch));
    },
    idle() {
      return queue;
    },
  };
}
