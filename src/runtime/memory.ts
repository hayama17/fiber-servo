/**
 * The in-memory `Runtime`: everything a real adapter does, minus containerd
 * and nerdctl.
 *
 * This is not a mock. A mock stands in for a `Runtime` and asserts on how it
 * was called; this file *is* one — the smallest complete implementation of
 * the contract in `./types.ts`. It keeps real containers (a map, not a
 * database), applies a `ComposeApplication` the same way `nerdctl compose up`
 * would (create what is missing, leave an unchanged service alone, replace a
 * changed one, remove what the model no longer declares), and emits the same
 * `RuntimeEvent`s a containerd watcher would.
 *
 * That the whole control plane — controllers, the planner, the control loop —
 * can be exercised end to end against this file without containerd running
 * anywhere is not a trick. It is the direct payoff of the runtime boundary in
 * `types.ts` being declarative: nothing above that boundary knows or cares
 * that "applying the application" here is a handful of `Map` operations
 * instead of a `nerdctl compose up` child process. Swap this file for
 * `./containerd` and the rest of the project does not need to know.
 *
 * ## Idempotence, precisely
 *
 * `apply()` is the one method every adapter must get exactly right (see the
 * contract's doc comment on `Runtime.apply`), so this reference
 * implementation states the rule as code, not prose:
 *
 *   desired service, no existing container      -> create
 *   desired service, existing, same spec digest,
 *     not exited                                -> untouched (same id!)
 *   desired service, existing, different digest  -> replace (new id)
 *   desired service, existing, but exited        -> restart (new id)
 *   existing container, service no longer
 *     declared in the model                      -> removed
 *
 * "same id" on the untouched row is the detail worth staring at: it is what
 * makes an unchanged `apply()` call a true no-op rather than a same-effect
 * replacement, which is what the control loop depends on to call `apply`
 * again after every observation without churning a healthy application.
 *
 * ## Readiness, and why this file only half-implements it
 *
 * `ComposeService` (`compose.ts`, fixed) has no field for
 * `ContainerSpec.readiness` — that type only carries what Compose itself
 * understands. Readiness is not this runtime's job at all; it is a separate
 * prober layered on top (see `observed.ts`'s file comment), and a real one
 * would actually run the probe's command. `compose.ts` owns the one
 * extension point that carries a probe across the `ComposeApplication`
 * boundary regardless: `toComposeService` stamps `READINESS_LABEL` whenever
 * `spec.readiness` is set, so any adapter can recover *that a container has
 * a probe* even though it never receives a `ContainerSpec` at all. This file
 * reads that label back to know a container has one (so `autoReady` and
 * `markReady` have something to act on), but stops short of running the
 * probe itself — this reference adapter's `ready` is only ever what
 * `autoReady` decides or a test sets with `markReady`.
 */
import type { ComposeApplication, ComposeService } from '../compose.js';
import { READINESS_LABEL, SPEC_LABEL } from '../compose.js';
import type {
  ContainerPhase,
  ObservedContainer,
  ObservedState,
  Runtime,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeFactory,
  Unsubscribe,
} from './types.js';

export interface MemoryRuntimeOptions {
  log?: (line: string) => void;
  /** Containers start `running` immediately when true (the default). False leaves them `waiting`. */
  autoStart?: boolean;
  /** Containers carrying `READINESS_LABEL` report ready immediately when true (the default). */
  autoReady?: boolean;
  now?: () => number;
}

export interface MemoryRuntime extends Runtime {
  /** Every call made, in order, as readable strings. The assertion surface for tests. */
  readonly calls: readonly string[];
  /** Test hook: make a container look like it exited on its own, without anyone asking for it. */
  kill(name: string, detail?: { exitCode?: number }): void;
  /** Test hook: mark one container ready (or unready). */
  markReady(name: string, ready?: boolean): void;
}

// ---- internal state ---------------------------------------------------------
//
// The public shape (`ObservedContainer`) is immutable and rebuilt on demand;
// what is actually stored is a plainer, mutable record so a mutation is just
// an assignment, not a rebuild of a nested tree.

interface InternalContainer {
  name: string;
  /** The runtime's own handle. Compose mangles `<project>-<service>-<n>`; a fresh one on every (re)create. */
  id: string;
  image: string;
  phase: ContainerPhase;
  exitCode?: number;
  /** Only set at all when the service carries `READINESS_LABEL`. */
  ready?: boolean;
  networks: string[];
  labels: Record<string, string>;
  specDigest?: string;
}

export function createMemoryRuntime(options: MemoryRuntimeOptions = {}): MemoryRuntime {
  const log = options.log ?? (() => {});
  const autoStart = options.autoStart ?? true;
  const autoReady = options.autoReady ?? true;
  const now = options.now ?? (() => Date.now());

  const containers = new Map<string, InternalContainer>();
  const listeners = new Set<RuntimeEventListener>();
  const calls: string[] = [];
  let revision = 0;
  let instanceCounter = 0;

  const record = (line: string): void => {
    calls.push(line);
    log(line);
  };

  const notify = (event: RuntimeEvent): void => {
    revision += 1;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        log(`fiber-servo: subscriber threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const toObserved = (c: InternalContainer): ObservedContainer => ({
    name: c.name,
    id: c.id,
    phase: c.phase,
    exitCode: c.exitCode,
    ready: c.ready,
    image: c.image,
    networks: [...c.networks],
    labels: { ...c.labels },
    specDigest: c.specDigest,
    at: now(),
  });

  /** A fresh internal record for `name`, as if Compose had just created (or recreated) it. */
  const buildContainer = (project: string, name: string, service: ComposeService): InternalContainer => {
    instanceCounter += 1;
    const labels = { ...service.labels };
    const hasReadiness = labels[READINESS_LABEL] !== undefined;
    return {
      name,
      id: `${project}-${name}-${instanceCounter}`,
      image: service.image,
      phase: autoStart ? 'running' : 'waiting',
      exitCode: undefined,
      ready: hasReadiness ? autoStart && autoReady : undefined,
      networks: [...(service.networks ?? [])],
      labels,
      specDigest: labels[SPEC_LABEL],
    };
  };

  const runtime: MemoryRuntime = {
    get calls(): readonly string[] {
      return calls;
    },

    async apply(model: ComposeApplication): Promise<void> {
      record(`apply ${model.name} services=${Object.keys(model.services).length}`);

      // Orphans first: a service the model no longer declares is removed,
      // same ordering `nerdctl compose up --remove-orphans` uses in practice
      // and the containerd adapter follows too (see its file comment).
      for (const name of [...containers.keys()]) {
        if (!(name in model.services)) {
          containers.delete(name);
          record(`remove ${name}`);
          notify({ type: 'container-removed', name });
        }
      }

      for (const [name, service] of Object.entries(model.services)) {
        const existing = containers.get(name);
        const digest = service.labels?.[SPEC_LABEL];
        if (existing && existing.phase !== 'exited' && existing.specDigest === digest) {
          // Idempotent: this is the exact container we already have, still
          // alive. Left completely alone — same id, no event, nothing to see.
          record(`skip ${name} (unchanged)`);
          continue;
        }
        const reason = !existing ? 'create' : existing.phase === 'exited' ? 'restart' : 'replace';
        const built = buildContainer(model.name, name, service);
        containers.set(name, built);
        record(`${reason} ${name} image=${service.image}`);
        notify({ type: 'container', container: toObserved(built) });
      }
    },

    async down(): Promise<void> {
      record('down');
      for (const name of [...containers.keys()]) {
        containers.delete(name);
        notify({ type: 'container-removed', name });
      }
    },

    async inspect(): Promise<ObservedState> {
      record('inspect');
      return {
        containers: new Map([...containers].map(([name, c]) => [name, toObserved(c)])),
        revision,
      };
    },

    subscribe(listener: RuntimeEventListener): Unsubscribe {
      record('subscribe');
      listeners.add(listener);
      return () => {
        record('unsubscribe');
        listeners.delete(listener);
      };
    },

    async close(): Promise<void> {
      record('close');
      listeners.clear();
    },

    kill(name: string, detail?: { exitCode?: number }): void {
      record(`kill ${name}${detail?.exitCode !== undefined ? ` exitCode=${detail.exitCode}` : ''}`);
      const target = containers.get(name);
      if (!target) throw new Error(`fiber-servo: cannot kill "${name}": no such container`);
      target.phase = 'exited';
      target.exitCode = detail?.exitCode;
      if (target.ready !== undefined) target.ready = false;
      notify({ type: 'container', container: toObserved(target) });
    },

    markReady(name: string, ready = true): void {
      record(`markReady ${name} ready=${ready}`);
      const target = containers.get(name);
      if (!target) throw new Error(`fiber-servo: cannot mark ready: no such container "${name}"`);
      target.ready = ready;
      notify({ type: 'container', container: toObserved(target) });
    },
  };

  return runtime;
}

/** As a `RuntimeFactory`, for `serve()`. */
export function memory(options: MemoryRuntimeOptions = {}): RuntimeFactory {
  return (ctx) => createMemoryRuntime({ ...options, log: options.log ?? ctx.log });
}
