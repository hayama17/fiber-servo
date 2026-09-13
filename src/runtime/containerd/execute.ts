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
import type { ContainerSpec, NetworkSpec, Op, OpSink } from '../../ops.js';
import type { PruneKeep } from '../../serve.js';
import type { StatusStore } from '../../status.js';
import { isManaged, parsePsLine } from './events.js';
import { MANAGED_LABEL, SPEC_LABEL, type ExecResult, type Nerdctl } from './nerdctl.js';

export interface ContainerdRuntimeOptions {
  nerdctl: Nerdctl;
  /** Receives `dead` for CREATE / START failures. Optional but recommended. */
  status?: StatusStore;
  /**
   * Maps a containerd id (64 hex) to its fiber-servo name. Share it with the
   * event watcher so events for containers created here resolve without an
   * extra `inspect`.
   */
  index?: Map<string, string>;
  log?: (line: string) => void;
  onError?: (error: Error, op: Op) => void;
  /** How often `probe()` looks for containers due for a readiness check. Default 250. */
  probeTickMs?: number;
}

export interface ContainerdRuntime {
  sink: OpSink;
  /** Resolves once every batch received so far has been executed. */
  idle(): Promise<void>;
  /**
   * Readiness prober: runs each container's `readiness.exec` inside it
   * (`nerdctl exec`) while it is running and not yet ready, and marks the
   * store `ready` on exit 0. Runs until `signal` aborts.
   */
  probe(signal: AbortSignal): Promise<void>;
  /**
   * Remove every managed resource the tree does not declare, and return the
   * names removed (containers first, then networks). This is the only place
   * that asks containerd what exists instead of looking up what the tree
   * names; see docs/decisions.md 20 for when it is safe to call.
   */
  prune(keep: PruneKeep): Promise<string[]>;
}

/** Stable digest of a spec; stored as a label so CREATE can recognise a resource it already made. */
export function specDigest(spec: ContainerSpec | NetworkSpec): string {
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
 * `ports` are container-side metadata until a Service decides how they are
 * published; they still take part in the digest.
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
  if (spec.network) args.push('--network', spec.network);
  for (const p of spec.publish ?? []) {
    args.push('-p', `${p.host}:${p.container}${p.protocol && p.protocol !== 'tcp' ? `/${p.protocol}` : ''}`);
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push('-e', `${k}=${v}`);
  for (const [k, v] of Object.entries(spec.labels ?? {})) args.push('--label', `${k}=${v}`);
  args.push(spec.image, ...(spec.command ?? []));
  return args;
}

/** argv for `nerdctl network create` from a spec. */
export function networkCreateArgs(spec: NetworkSpec): string[] {
  const args = [
    'network',
    'create',
    '--label',
    `${MANAGED_LABEL}=true`,
    '--label',
    `${SPEC_LABEL}=${specDigest(spec)}`,
  ];
  if (spec.subnet) args.push('--subnet', spec.subnet);
  for (const [k, v] of Object.entries(spec.labels ?? {})) args.push('--label', `${k}=${v}`);
  args.push(spec.name);
  return args;
}

interface Inspected {
  id: string;
  running: boolean;
  digest: string | undefined;
}

export function createContainerdRuntime(options: ContainerdRuntimeOptions): ContainerdRuntime {
  const {
    nerdctl,
    status,
    index,
    log = () => {},
    onError = (e) => console.error(e),
    probeTickMs = 250,
  } = options;
  /** Last spec we were asked to realise per name, so START can recreate a vanished container. */
  const specs = new Map<string, ContainerSpec>();
  let queue: Promise<void> = Promise.resolve();

  /**
   * Everything that touches containerd goes through here, so a prune cannot
   * interleave with a batch in flight. The queue itself never carries a
   * rejection: the caller of `enqueue` owns the failure.
   */
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async function call(args: string[]): Promise<ExecResult> {
    log(`$ nerdctl ${args.join(' ')}`);
    return nerdctl.exec(args);
  }

  function fail(res: ExecResult, what: string): Error {
    return new Error(`nerdctl ${what} failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }

  // ---- containers ---------------------------------------------------------

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

  // ---- networks -----------------------------------------------------------

  async function createNetwork(spec: NetworkSpec): Promise<void> {
    const existing = await call([
      'network',
      'inspect',
      '--format',
      `{{index .Labels "${SPEC_LABEL}"}}`,
      spec.name,
    ]);
    if (existing.code === 0) {
      const digest = existing.stdout.trim();
      if (digest === specDigest(spec)) return; // adopt
      if (digest === '') return; // pre-existing, not ours: use it as is
      throw new Error(
        `nerdctl network ${spec.name} exists with a different spec; networks are immutable, remove it or rename`,
      );
    }
    const res = await call(networkCreateArgs(spec));
    if (res.code !== 0) throw fail(res, `network create ${spec.name}`);
  }

  async function removeNetwork(name: string): Promise<void> {
    const res = await call(['network', 'rm', name]);
    if (res.code !== 0 && !/no such|not found/i.test(res.stderr)) throw fail(res, `network rm ${name}`);
  }

  // ---- dispatch -----------------------------------------------------------

  async function execute(op: Op): Promise<void> {
    if (op.kind === 'network') {
      switch (op.type) {
        case 'CREATE':
          return createNetwork(op.spec);
        case 'DELETE':
          return removeNetwork(op.id);
        case 'UPDATE':
          throw new Error(
            `network ${op.id}: [${op.changed.join(',')}] changed but networks are immutable; rename it`,
          );
      }
    }
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
        if (op.kind === 'container' && op.type !== 'DELETE') {
          status?.set(op.id, 'dead', { reason: error.message });
        }
      }
    }
  }

  // ---- pruning ------------------------------------------------------------

  /**
   * Names of every managed container, from containerd rather than from the
   * tree. The label filter is an optimisation; `parsePsLine` checks the label
   * again, so a nerdctl that ignored the filter still cannot make us delete a
   * foreign container.
   */
  async function managedContainers(): Promise<string[]> {
    const res = await call([
      'ps',
      '-a',
      '--no-trunc',
      '--filter',
      `label=${MANAGED_LABEL}=true`,
      '--format',
      '{{json .}}',
    ]);
    if (res.code !== 0) throw fail(res, 'ps -a');
    const names: string[] = [];
    for (const line of res.stdout.split('\n')) {
      const row = parsePsLine(line);
      if (row) names.push(row.name);
    }
    return names;
  }

  /**
   * Names of every managed network. `network ls` grew `--filter label=` and a
   * `Labels` column late, so rows without one are resolved with an `inspect`
   * instead of trusting a filter the daemon may have dropped.
   */
  async function managedNetworks(): Promise<string[]> {
    const res = await call(['network', 'ls', '--format', '{{json .}}']);
    if (res.code !== 0) throw fail(res, 'network ls');
    const names: string[] = [];
    for (const line of res.stdout.split('\n')) {
      const row = parseJson<{ Name?: string; Labels?: string }>(line);
      const name = row?.Name?.trim();
      if (!row || !name) continue;
      const managed = row.Labels === undefined ? await networkIsManaged(name) : isManaged(row.Labels);
      if (managed) names.push(name);
    }
    return names;
  }

  async function networkIsManaged(name: string): Promise<boolean> {
    const res = await call(['network', 'inspect', '--format', `{{index .Labels "${MANAGED_LABEL}"}}`, name]);
    return res.code === 0 && res.stdout.trim() === 'true';
  }

  async function prune(keep: PruneKeep): Promise<string[]> {
    const removed: string[] = [];
    // Containers before networks: a network with a container still attached
    // cannot be removed.
    const keptContainers = new Set(keep.containers);
    for (const name of await managedContainers()) {
      if (keptContainers.has(name)) continue;
      if (await pruneOne('container', name, () => remove(name))) {
        specs.delete(name);
        status?.remove(name);
        removed.push(name);
      }
    }
    const keptNetworks = new Set(keep.networks);
    for (const name of await managedNetworks()) {
      if (keptNetworks.has(name)) continue;
      if (await pruneOne('network', name, () => removeNetwork(name))) removed.push(name);
    }
    return removed;
  }

  async function pruneOne(
    kind: 'container' | 'network',
    id: string,
    run: () => Promise<void>,
  ): Promise<boolean> {
    log(`prune ${kind} ${id}`);
    try {
      await run();
      return true;
    } catch (e) {
      // One resource refusing to go is not a reason to leave the rest.
      onError(e instanceof Error ? e : new Error(String(e)), { type: 'DELETE', kind, id });
      return false;
    }
  }

  // ---- readiness ----------------------------------------------------------

  async function probe(signal: AbortSignal): Promise<void> {
    const lastAttempt = new Map<string, number>();
    while (!signal.aborted) {
      const now = Date.now();
      for (const [name, spec] of specs) {
        const readiness = spec.readiness;
        if (!readiness || !status) continue;
        const current = status.get(name);
        if (current.state !== 'running' || current.ready === true) continue;
        if (now - (lastAttempt.get(name) ?? 0) < (readiness.intervalMs ?? 2000)) continue;
        lastAttempt.set(name, now);
        const res = await nerdctl.exec(['exec', name, ...readiness.exec]);
        // Only mark the snapshot the probe was run against; a death in between wins.
        if (res.code === 0 && status.get(name) === current) {
          log(`ready ${name}`);
          status.mark(name, { ready: true });
        }
      }
      await sleep(probeTickMs, signal);
    }
  }

  return {
    sink(ops) {
      const batch = [...ops];
      void enqueue(() => executeBatch(batch));
    },
    idle() {
      return queue;
    },
    probe,
    prune(keep) {
      return enqueue(() => prune(keep));
    },
  };
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
