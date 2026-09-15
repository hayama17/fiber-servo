/**
 * containerd as a `Runtime` (`../types.ts`), driven through `nerdctl compose`.
 *
 * ---- apply() is two steps because `compose up` alone cannot replace -------
 *
 * `nerdctl compose -f <file> up -d --no-recreate` is idempotent (verified
 * live against nerdctl 2.1.2: zero re-creations, container ids stable when
 * nothing changed) and self-healing (a killed container comes back via
 * `nerdctl start`, for free). What it will never do is notice that a
 * *running* service's image or command changed -- `--no-recreate` means
 * exactly that, literally. So a changed spec has to be evicted before `up`
 * ever sees it:
 *
 *   a. render `model` to `composeFile` -- a stable path, not a temp file:
 *      `down()` has to find the same project later, possibly from a fresh
 *      process that never called `apply()`.
 *   b. `nerdctl compose -f <file> rm -f -s <service>` for every service whose
 *      recorded `fiber-servo.spec` digest (`SPEC_LABEL`, from `compose.ts`)
 *      differs from what `model` now asks for, plus every service `model` no
 *      longer declares at all (`changedServices`/`orphanedServices` in
 *      `compose.ts`, fed from this adapter's own `inspect()`).
 *   c. `nerdctl compose -f <file> up -d --no-recreate` -- creates whatever
 *      step (b) just evicted, creates whatever is new, restarts whatever was
 *      merely stopped. One command does all three; nothing here has to tell
 *      them apart.
 *
 * **A measured wrinkle step (b) has to work around.** `compose rm -s
 * <service>` validates its target against the services declared in the file
 * loaded with `-f` -- verified live: pointed at a file that no longer has the
 * key, nerdctl fails outright with `no such service: b`, it does not fall
 * back to finding the container by label. An orphaned service is by
 * definition gone from `model`, so it would never appear in the file `apply`
 * is about to write. `withRemovalStubs` below works around this by adding a
 * bare `{ image }` entry for each orphan -- enough for `rm` to accept the
 * name, nothing that could make it try to pull or start anything -- and the
 * file gets rewritten to the *true* desired model immediately afterwards, so
 * `up` never sees the stub and never recreates what `rm` just removed. This
 * is not one of the facts handed down for this rewrite; it was checked
 * against a real daemon specifically because guessing it would have repeated
 * the mistake decision 29 already paid for once (a fake answering "no such
 * network", a string real nerdctl never emits).
 *
 * ---- reads stay on containerd's own API -------------------------------------
 *
 * `inspect()` and `subscribe()` never shell out. `api.listContainers()` /
 * `api.listTasks()` / `api.subscribe()` (`api.ts`) are containerd's own gRPC
 * read path, unchanged by the move to Compose -- a container is still a
 * container, and `com.docker.compose.project` / `com.docker.compose.service`
 * (`compose.ts`) are just two more labels on it. `nerdctl/networks` is a
 * label too, so a container's network membership comes from the same
 * `listContainers()` call, no CNI file reading needed (the old adapter's
 * `cni.ts` -- Compose owns network lifecycle now, and `ObservedState` has no
 * top-level networks to read back at all; see `types.ts`).
 *
 * `namespace` has to reach both halves identically -- nerdctl's `--namespace`
 * flag and containerd's gRPC metadata -- or writes and reads would silently
 * talk to two different containerd namespaces. `index.ts` computes it once
 * and hands the same string to both seams; nothing in this file derives it a
 * second time.
 *
 * ---- staying observable without trusting one source forever ----------------
 *
 * Same discipline as before: `subscribe()` streams `api.subscribe` and
 * translates events as they arrive, but resyncs fully with one `inspect()`
 * both when a subscriber first attaches and whenever the stream ends, before
 * trying to reattach (`runEventLoop`). `api.subscribe` already serialises
 * deliveries to the handler passed to it (see its contract in `api.ts`), so
 * `attachOnce` below does not rebuild that ordering -- it only has to route a
 * handler failure into `finish` so the loop can resync and reattach.
 *
 * The readiness prober runs alongside it. It cannot be delegated to Compose:
 * nerdctl's compose does not implement the Compose spec's `healthcheck` at
 * all (verified: `up` accepts one in the file and silently ignores it), so
 * "is this container answering yet" has to be asked directly, the same way
 * the pre-Compose adapter asked it -- `nerdctl compose exec <service>
 * <probe...>` (or plain `nerdctl exec <container>`; this file uses the
 * former so a probe target is a service name, the same identity everything
 * else in this file uses). The probe definition itself rides in the service's
 * labels, under `compose.ts`'s `READINESS_LABEL` -- the only channel there
 * is, since `apply()` is handed a `ComposeApplication` and nothing more.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  changedServices,
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  orphanedServices,
  renderCompose,
  type ComposeApplication,
  type ComposeService,
} from '../../compose.js';
import type { ReadinessProbe } from '../../resources.js';
import type {
  ObservedContainer,
  ObservedState,
  Runtime,
  RuntimeEvent,
  RuntimeEventListener,
  Unsubscribe,
} from '../types.js';
import type { ExecResult, Nerdctl } from './nerdctl.js';
import type { ApiContainer, ApiEvent, ApiTask, ContainerdApi } from './api.js';
import { decodeReadiness, READINESS_LABEL, toObservedContainer } from './parse.js';

export interface ContainerdRuntimeOptions {
  /** The process-execution seam for `compose`/`exec`; see `nerdctl.ts`. Tests inject a fake here. */
  nerdctl: Nerdctl;
  /** The gRPC read seam; see `api.ts`. Tests inject a fake here too. */
  api: ContainerdApi;
  /** The Compose project every container this adapter manages belongs to. */
  project: string;
  /**
   * Where the rendered model is written. Must be a stable path: `apply`
   * writes it and `down` needs the very same file later, possibly from a
   * process that never called `apply` in this run at all.
   */
  composeFile: string;
  log?: (line: string) => void;
  onError?: (error: Error) => void;
  /** How often the readiness prober looks for containers due for a check. Default 250. */
  probeTickMs?: number;
  /** Delay before reattaching a dead event stream, and the spacing of the resync fallback while it stays down. Default 1000. */
  reconnectDelayMs?: number;
  now?: () => number;
}

interface ReadinessTarget {
  probe: ReadinessProbe;
  /** Local latch: once true, the prober leaves this service alone until it is recreated. */
  ready: boolean;
}

export function createContainerdRuntime(options: ContainerdRuntimeOptions): Runtime {
  const { nerdctl, api, project, composeFile } = options;
  const log = options.log ?? (() => {});
  const onError = options.onError ?? ((e: Error) => console.error(e));
  const probeTickMs = options.probeTickMs ?? 250;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  const now = options.now ?? (() => Date.now());

  /** containerd id -> Compose service name. Populated by every list/resync and by `resolveId` on demand. */
  const idIndex = new Map<string, string>();
  /** Ids confirmed to belong to a different project (or no project at all), cached so they are looked up at most once. */
  const notOurs = new Set<string>();
  /** Service name -> its readiness schedule. See `compose.ts`'s `READINESS_LABEL` doc for where this comes from. */
  const readinessTargets = new Map<string, ReadinessTarget>();
  const listeners = new Set<RuntimeEventListener>();
  let controller: AbortController | undefined;
  let revision = 0;

  // ---- process execution -----------------------------------------------------

  async function call(args: readonly string[]): Promise<ExecResult> {
    log(`$ nerdctl ${args.join(' ')}`);
    return nerdctl.exec(args);
  }

  function fail(res: ExecResult, what: string): Error {
    return new Error(`nerdctl ${what} failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }

  function notify(event: RuntimeEvent): void {
    revision += 1;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        log(`fiber-servo: subscriber threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  function writeModel(app: ComposeApplication): void {
    mkdirSync(dirname(composeFile), { recursive: true });
    writeFileSync(composeFile, renderCompose(app));
  }

  /**
   * The last model that declared anything, kept for `down()`.
   *
   * `compose down` removes the project's networks, but only the ones the file
   * it is given declares -- and by the time `down()` runs, the file on disk
   * has usually been reduced to the empty model by a final `apply()` (that is
   * exactly what `serve().stop()` does: unmount, apply nothing, then tear
   * down). Handing `down` that file removes nothing, and the network outlives
   * the application. Verified live: the network was still there afterwards.
   */
  let lastDeclared: ComposeApplication | undefined;

  /**
   * `model` plus a minimal stub entry for each service in `orphaned` -- just
   * enough for `compose rm -f -s` to accept the name; see the file doc for
   * why this exists at all. The stub's image is whatever this service was
   * last observed running, purely so the rendered file reads sensibly to a
   * human glancing at it; `rm` never resolves or starts it.
   */
  function withRemovalStubs(
    model: ComposeApplication,
    orphaned: readonly string[],
    lastImage: ReadonlyMap<string, string>,
  ): ComposeApplication {
    if (orphaned.length === 0) return model;
    const stubs: Record<string, ComposeService> = {};
    for (const name of orphaned) stubs[name] = { image: lastImage.get(name) ?? 'scratch' };
    return { ...model, services: { ...model.services, ...stubs } };
  }

  // ---- reading containers -----------------------------------------------------

  /** The Compose service name a containerd row belongs to, or `undefined` if it is not this adapter's project. */
  function serviceOf(row: ApiContainer): string | undefined {
    if (row.labels[COMPOSE_PROJECT_LABEL] !== project) return undefined;
    return row.labels[COMPOSE_SERVICE_LABEL];
  }

  async function readProjectContainers(): Promise<ObservedContainer[]> {
    const [rows, tasks] = await Promise.all([api.listContainers(), api.listTasks()]);
    const taskById = new Map(tasks.map((t) => [t.id, t] as const));
    const at = now();
    const result: ObservedContainer[] = [];
    for (const row of rows) {
      const service = serviceOf(row);
      if (!service) continue;
      idIndex.set(row.id, service);
      result.push(toObservedContainer(row, taskById.get(row.id), readinessTargets.get(service)?.ready, at));
    }
    return result;
  }

  async function inspectOne(service: string): Promise<ObservedContainer | undefined> {
    const containers = await readProjectContainers();
    return containers.find((c) => c.name === service);
  }

  async function inspect(): Promise<ObservedState> {
    const containers = await readProjectContainers();
    // Recover a probe schedule this process never saw registered -- e.g.
    // after a restart. `READINESS_LABEL` on the running container's own
    // labels is the only place it survives; see parse.ts.
    for (const c of containers) {
      if (readinessTargets.has(c.name)) continue;
      const probe = decodeReadiness(c.labels[READINESS_LABEL]);
      if (probe) readinessTargets.set(c.name, { probe, ready: false });
    }
    return { containers: new Map(containers.map((c) => [c.name, c])), revision };
  }

  // ---- apply / down -----------------------------------------------------------

  /** `fiber-servo.spec` digest and last-known image per service, for this project alone. */
  async function recordedState(): Promise<{ digests: Map<string, string>; images: Map<string, string> }> {
    const containers = await readProjectContainers();
    const digests = new Map<string, string>();
    const images = new Map<string, string>();
    for (const c of containers) {
      if (c.specDigest !== undefined) digests.set(c.name, c.specDigest);
      if (c.image !== undefined) images.set(c.name, c.image);
    }
    return { digests, images };
  }

  /**
   * Registers what the prober should probe from `model`, and prunes what it
   * should not. A service in `resetFor` (just recreated, or brand new) always
   * starts unready; an unchanged service keeps whatever the prober already
   * decided about it -- re-arming it here would make an already-ready
   * container flicker unready on every `apply`, even one that changed
   * nothing about it.
   */
  function syncReadinessTargets(model: ComposeApplication, resetFor: ReadonlySet<string>): void {
    for (const service of readinessTargets.keys()) {
      if (!(service in model.services)) readinessTargets.delete(service);
    }
    for (const [service, def] of Object.entries(model.services)) {
      const probe = decodeReadiness(def.labels?.[READINESS_LABEL]);
      if (!probe) {
        readinessTargets.delete(service);
        continue;
      }
      const existing = readinessTargets.get(service);
      if (!existing || resetFor.has(service)) readinessTargets.set(service, { probe, ready: false });
      else existing.probe = probe;
    }
  }

  async function apply(model: ComposeApplication): Promise<void> {
    // The model names the project it is; this adapter reads containers back
    // by that same name. If the two ever disagreed, every `inspect()` would
    // filter for a project nothing was created under, the plan would report
    // the whole application missing on every pass, and the loop would apply
    // it again for ever without a single error. Saying so once, loudly, is
    // worth more than an infinite quiet retry.
    if (model.name !== project) {
      throw new Error(
        `fiber-servo: this adapter reads project "${project}" but was handed a model for "${model.name}". ` +
          `Set the project in one place — serve({ project }) passes it to the adapter for you.`,
      );
    }
    if (Object.keys(model.services).length > 0 || Object.keys(model.networks).length > 0) {
      lastDeclared = model;
    }
    const { digests, images } = await recordedState();
    const changed = changedServices(model, digests);
    const orphaned = orphanedServices(model, digests);
    const toRemove = [...new Set([...changed, ...orphaned])].sort();

    writeModel(withRemovalStubs(model, orphaned, images));

    if (toRemove.length > 0) {
      const res = await call(['compose', '-f', composeFile, 'rm', '-f', '-s', ...toRemove]);
      if (res.code !== 0) throw fail(res, `compose rm -s ${toRemove.join(' ')}`);
    }

    // Whether or not there was anything to remove, the file on disk must end
    // up exactly `model` -- dropping any removal stub -- before `up` runs, or
    // `up` would recreate the very orphan `rm` just evicted. A no-op write
    // when `toRemove` was empty.
    writeModel(model);

    // An empty application is a legitimate desired state -- it is what the
    // last pass of `serve().stop()` asks for, and what a tree that renders
    // nothing asks for -- but `compose up` on a file with no services is a
    // hard error (`no service was provided`, verified live). Step (b) has
    // already removed whatever was there, so there is genuinely nothing left
    // for `up` to do.
    if (Object.keys(model.services).length === 0) {
      syncReadinessTargets(model, new Set(changed));
      return;
    }

    const res = await call(['compose', '-f', composeFile, 'up', '-d', '--no-recreate']);
    if (res.code !== 0) throw fail(res, 'compose up');

    syncReadinessTargets(model, new Set(changed));
  }

  async function down(): Promise<void> {
    // Restore what the application last declared, so `down` has the networks
    // to remove; see `lastDeclared`. A process that never applied anything in
    // this run has nothing to restore and falls back to the file on disk,
    // which is the point of that file being at a stable path.
    if (lastDeclared) writeModel(lastDeclared);
    if (!existsSync(composeFile)) return; // nothing was ever applied: down is idempotent
    const res = await call(['compose', '-f', composeFile, 'down']);
    if (res.code !== 0) throw fail(res, 'compose down');
    idIndex.clear();
    notOurs.clear();
    readinessTargets.clear();
    lastDeclared = undefined;
  }

  // ---- events -----------------------------------------------------------------

  async function resolveId(id: string): Promise<string | undefined> {
    const known = idIndex.get(id);
    if (known) return known;
    if (notOurs.has(id)) return undefined;
    const container = await api.getContainer(id);
    const service = container ? serviceOf(container) : undefined;
    if (!service) {
      notOurs.add(id);
      return undefined;
    }
    idIndex.set(id, service);
    return service;
  }

  /**
   * `/tasks/start`, `/tasks/exit` and `/tasks/delete` all concern one
   * container's task, and all three are handled the same way: find out what
   * that service looks like now, and say so. A task being gone does not mean
   * the *container* is -- `no task -> exited` (`phaseFromTask` in parse.ts)
   * covers that as just another phase. Only when the container itself is
   * gone too does this report a removal, and that is `reconcileDeletion`'s
   * job below, not this function's.
   */
  async function handleTaskEvent(containerId: string): Promise<void> {
    const service = await resolveId(containerId);
    if (!service) return; // not ours
    const container = await inspectOne(service);
    if (container) notify({ type: 'container', container });
    else notify({ type: 'container-removed', name: service });
  }

  /**
   * `/containers/delete` means a container is gone. The event does name it --
   * `ContainerDelete`'s field is `id`, not the `container_id` task events
   * use, and `api.ts` decodes both (a difference that silently broke this
   * topic until it was caught against a live daemon) -- but this function
   * deliberately does not rely on that name.
   *
   * The reason is that one deletion rarely arrives alone: `compose rm` on
   * three services produces three events, and Compose recreating a container
   * produces a delete for the old one. Diffing the id index against one fresh
   * `listContainers()` answers for all of them at once, and it answers
   * correctly even for a deletion whose event was dropped while the stream
   * was down. Every id in the index was put there by a list call, so the
   * difference is exactly the set of *our* containers that disappeared -- no
   * guessing, and no broad resync of things that did not change.
   */
  async function reconcileDeletion(): Promise<void> {
    const rows = await api.listContainers();
    const present = new Set(rows.map((r) => r.id));
    const removed: string[] = [];
    for (const [id, service] of idIndex) {
      if (present.has(id)) continue;
      idIndex.delete(id);
      readinessTargets.delete(service);
      removed.push(service);
    }
    for (const service of removed) notify({ type: 'container-removed', name: service });
  }

  async function handleApiEvent(event: ApiEvent): Promise<void> {
    switch (event.topic) {
      case '/tasks/start':
      case '/tasks/exit':
      case '/tasks/delete':
        // An event whose payload could not be decoded (see api.ts's own
        // comment on that) is still worth acting on by resyncing fully, the
        // same fallback a dead stream gets below.
        if (event.containerId) await handleTaskEvent(event.containerId);
        else await resyncOnce();
        return;
      case '/containers/delete':
        await reconcileDeletion();
        return;
      default:
        return; // containers/create, containers/update, snapshot/*, ... -- nothing this adapter acts on
    }
  }

  async function resyncOnce(): Promise<void> {
    try {
      const state = await inspect();
      notify({ type: 'resync', containers: [...state.containers.values()] });
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * Attach to the event stream once, and resolve when it ends or is aborted.
   *
   * Events arrive already serialised: `api.subscribe` waits for each handler
   * to settle before delivering the next (see its contract in `api.ts`). All
   * this has to do is route a handler failure to `finish`, which tears the
   * attachment down so `runEventLoop` can resync and reattach.
   */
  function attachOnce(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (error?: Error): void => {
        if (done) return;
        done = true;
        if (error) onError(error);
        signal.removeEventListener('abort', onAbort);
        unsubscribe();
        resolve();
      };
      const onAbort = (): void => finish();
      const unsubscribe = api.subscribe(
        // Returning the promise is what lets `api.subscribe` hold the next
        // event back until this one is done.
        (event) =>
          handleApiEvent(event).catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e)))),
        (error) => finish(error),
      );
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function runEventLoop(signal: AbortSignal): Promise<void> {
    // Resync once up front: whatever happened while nobody was subscribed
    // (or before this process existed) has to be caught up before trusting
    // events alone, same as after any later reattach.
    await resyncOnce();
    while (!signal.aborted) {
      await attachOnce(signal);
      if (signal.aborted) return;
      // The stream ended -- containerd restarted, the socket dropped, or
      // handling an event threw. Nothing guarantees we saw everything up to
      // that point, so resync fully and announce it before trying to
      // reattach. If the stream keeps failing, this repeats, so the resync
      // is genuinely periodic for as long as it stays down.
      await resyncOnce();
      await sleep(reconnectDelayMs, signal);
    }
  }

  async function runProber(signal: AbortSignal): Promise<void> {
    const lastAttempt = new Map<string, number>();
    while (!signal.aborted) {
      const t = Date.now();
      for (const [service, target] of readinessTargets) {
        if (target.ready) continue;
        const interval = target.probe.intervalMs ?? 2000;
        if (t - (lastAttempt.get(service) ?? 0) < interval) continue;
        lastAttempt.set(service, t);
        const res = await nerdctl.exec(
          ['compose', '-f', composeFile, 'exec', service, ...target.probe.exec],
          { timeoutMs: target.probe.timeoutMs ?? 2000 },
        );
        // Only mark it once: a concurrent removal clears the target from the
        // map entirely, so a stale success cannot resurrect it.
        if (res.code === 0 && readinessTargets.get(service) === target && !target.ready) {
          target.ready = true;
          log(`ready ${service}`);
          const container = await inspectOne(service);
          if (container) notify({ type: 'container', container });
        }
      }
      await sleep(probeTickMs, signal);
    }
  }

  function ensureWatching(): void {
    if (controller) return;
    const c = new AbortController();
    controller = c;
    void Promise.all([runEventLoop(c.signal), runProber(c.signal)]).catch((e) =>
      onError(e instanceof Error ? e : new Error(String(e))),
    );
  }

  function subscribe(listener: RuntimeEventListener): Unsubscribe {
    listeners.add(listener);
    ensureWatching(); // lazy: no event stream or prober runs until the first subscriber needs one
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        controller?.abort();
        controller = undefined;
      }
    };
  }

  async function close(): Promise<void> {
    controller?.abort();
    controller = undefined;
    listeners.clear();
    api.close();
  }

  return { apply, down, inspect, subscribe, close };
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
