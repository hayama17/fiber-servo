/**
 * containerd as a `Runtime` (`../types.ts`): the orchestration engine. Every
 * other file in this directory is a helper this one calls.
 *
 * ---- The central problem: being a Pod on nerdctl -----------------------
 *
 * containerd has no Pod. What this adapter does is exactly what CRI does on
 * top of the same primitive: fake one out of two containers.
 *
 *   - An "infra" (sandbox) container, named after the Pod itself, that does
 *     nothing but hold a network namespace open (`registry.k8s.io/pause`).
 *   - One real container per `ContainerSpec`, named `<pod>-<container>`,
 *     started with `--network=container:<pod>` instead of a network of its
 *     own -- that flag is what makes it join the sandbox's namespace rather
 *     than get one, and it is the single most important line in this file.
 *
 * The consequence that follows directly from that flag, and that trips up
 * every first attempt at this: **a host port can only be published on
 * whichever container owns the network namespace.** Once a container joins
 * one with `--network=container:X`, it has no namespace of its own left to
 * publish a port on -- `nerdctl` refuses `-p` there outright. So
 * `PodTemplate.publish` is applied to the *infra* container's `run`
 * (`naming.ts`'s `infraRunArgs`), never to a member's, no matter which
 * member's process is the one actually listening. `ObservedPod.ip` follows
 * the same logic: it is the infra container's address, because that address
 * is the Pod's address -- every member answers on it too, by construction.
 *
 * Everything else follows from having two kinds of container instead of one:
 *
 *   - `createPod` creates the sandbox, then every member, in that order (a
 *     member cannot join a namespace that does not exist yet); `removePod`
 *     removes every container carrying the Pod's `POD_LABEL`, sandbox
 *     included, found with one `ps --filter` rather than a remembered list.
 *   - Adoption is by spec digest (decision 10 in `docs/decisions.md`), same
 *     as everywhere else in this project: every resource this adapter
 *     creates is labelled with `digest(spec)` of *that resource's own*
 *     spec -- the whole `PodSpec` on the sandbox, one `ContainerSpec` per
 *     member -- so a restarted process recognises what it already made
 *     instead of recreating it. `MANAGED_LABEL`/`POD_LABEL`/`ROLE_LABEL`
 *     (all defined in `nerdctl.ts`) are what let `inspect()` tell "ours" from
 *     "not ours" and "sandbox" from "member" out of a flat `ps -a` listing,
 *     and group members back under their Pod.
 *   - `ObservedPod.spec` is reconstructed from labels too, but *not* simply
 *     read back from one label -- see the comment above `reconstructPodSpec`
 *     in `parse.ts` for why (labels cannot be rewritten once a container
 *     exists, so a per-resource label plus a live cgroup read stands in for
 *     that instead).
 *
 * ---- Staying observable without trusting one source forever ------------
 *
 * `subscribe()` streams `nerdctl events` and translates lines as they
 * arrive, but a process that only ever streamed would go blind the moment
 * that stream ends (containerd restarting, the socket dropping) without
 * knowing what it missed. So the event loop, on any such end, resyncs fully
 * with one `inspect()` and emits it as a `resync` event before it tries to
 * reattach -- see `runEventLoop`. The readiness prober runs alongside it,
 * `nerdctl exec`-ing each container's probe until it exits 0 (decision 15).
 */
import type { ContainerSpec, NetworkSpec, PodSpec, ResourceLimits } from '../../resources.js';
import { digest } from '../../resources.js';
import type {
  ObservedContainer,
  ObservedNetwork,
  ObservedPod,
  ObservedState,
  Runtime,
  RuntimeEvent,
  RuntimeEventListener,
  Unsubscribe,
} from '../types.js';
import {
  CONTAINER_LABEL,
  MANAGED_LABEL,
  POD_LABEL,
  ROLE_LABEL,
  SPEC_LABEL,
  type ExecResult,
  type Nerdctl,
} from './nerdctl.js';
import {
  DEFAULT_SANDBOX_IMAGE,
  infraName,
  infraRunArgs,
  memberName,
  memberRunArgs,
  networkCreateArgs,
  updateResourcesArgs,
} from './naming.js';
import {
  bytesToMemory,
  decodeSpecLabel,
  derivePodPhase,
  interpretEventRow,
  isManaged,
  nanoCpusToCpu,
  parseJsonSafe,
  parsePsRow,
  phaseFromStateStatus,
  reconstructPodSpec,
  toObservedContainer,
  type EventRow,
  type ManagedRow,
} from './parse.js';

export interface ContainerdRuntimeOptions {
  /** The process-execution seam; see `nerdctl.ts`. Tests inject a fake here. */
  nerdctl: Nerdctl;
  /** Image for every Pod's sandbox container. Must do nothing but hold a network namespace open. Default: `DEFAULT_SANDBOX_IMAGE`. */
  sandboxImage?: string;
  log?: (line: string) => void;
  onError?: (error: Error) => void;
  /** How often the readiness prober looks for containers due for a check. Default 250. */
  probeTickMs?: number;
  /** Delay before reattaching a dead event stream, and the spacing of the resync fallback while it stays down. Default 1000. */
  reconnectDelayMs?: number;
  now?: () => number;
}

/** What the id index remembers about one containerd id, so an event can be resolved without an `inspect` on the hot path. */
type Tracked = { role: 'infra'; pod: string } | { role: 'member'; pod: string; container: string };

interface ReadinessTarget {
  pod: string;
  container: string;
  probe: NonNullable<ContainerSpec['readiness']>;
  /** Local latch: once true, the prober leaves this container alone until it is recreated. */
  ready: boolean;
}

interface NetworkRow {
  Name: string;
  Labels?: string;
}

export function createContainerdRuntime(options: ContainerdRuntimeOptions): Runtime {
  const { nerdctl } = options;
  const sandboxImage = options.sandboxImage ?? DEFAULT_SANDBOX_IMAGE;
  const log = options.log ?? (() => {});
  const onError = options.onError ?? ((e: Error) => console.error(e));
  const probeTickMs = options.probeTickMs ?? 250;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  const now = options.now ?? (() => Date.now());

  /** containerd id -> what it is. Populated by every `run` this process does, and by every `ps`/`inspect` sync. */
  const idIndex = new Map<string, Tracked>();
  /** Ids confirmed to carry no fiber-servo label, cached so a foreign container is inspected at most once. */
  const notOurs = new Set<string>();
  /** Runtime member name -> its readiness schedule. The only place probe config lives; see `parse.ts`'s recorded-spec note. */
  const readinessTargets = new Map<string, ReadinessTarget>();
  const listeners = new Set<RuntimeEventListener>();
  let controller: AbortController | undefined;
  let revision = 0;

  // ---- process execution ---------------------------------------------------

  async function call(args: readonly string[]): Promise<ExecResult> {
    log(`$ nerdctl ${args.join(' ')}`);
    return nerdctl.exec(args);
  }

  function fail(res: ExecResult, what: string): Error {
    return new Error(`nerdctl ${what} failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }

  /**
   * "It is already gone" versus "it failed". Removing something absent has to
   * be a no-op (see `Runtime` in types.ts: crash recovery depends on it), and
   * nerdctl signals that only by exiting non-zero with a particular message.
   *
   * These patterns are copied verbatim from nerdctl 2.x output, not guessed:
   *
   *   rm / stop / update    no such container: <name>
   *   inspect               no such object <name>
   *   network rm            no network found matching: <name>
   *                         no network could be removed
   *
   * The network wording shares no substring with the container ones, which is
   * exactly how this was first got wrong: a fake that made up "no such
   * network" matched a pattern real nerdctl never emits, so the test passed
   * and `removeNetwork` threw the first time it met a real daemon.
   */
  function isNotFound(res: ExecResult): boolean {
    return /no such |not found|no network found matching|no network could be removed/i.test(res.stderr);
  }

  function lastLine(text: string): string {
    return text.trim().split('\n').at(-1) ?? '';
  }

  function isContainerId(text: string): boolean {
    return /^[0-9a-f]{12,64}$/.test(text);
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

  // ---- single-container inspection -----------------------------------------

  interface Inspected {
    id: string;
    specDigest: string;
  }

  /** Presence + the resource's own `SPEC_LABEL`. `specDigest` is `''` for a container that exists but carries no such label -- see `createPod`. */
  async function inspectContainer(name: string): Promise<Inspected | null> {
    const res = await call(['inspect', '--format', `{{.Id}} {{index .Config.Labels "${SPEC_LABEL}"}}`, name]);
    if (res.code !== 0) return null;
    const [id = '', specDigest = ''] = res.stdout.trim().split(/\s+/);
    return { id, specDigest };
  }

  async function infraIp(name: string): Promise<string | undefined> {
    const res = await call(['inspect', '--format', '{{.NetworkSettings.IPAddress}}', name]);
    if (res.code !== 0) return undefined;
    return res.stdout.trim() || undefined;
  }

  async function inspectMemberContainer(
    pod: string,
    container: string,
  ): Promise<ObservedContainer | undefined> {
    const name = memberName(pod, container);
    const res = await call([
      'inspect',
      '--format',
      '{{.Id}} {{.State.Status}} {{.State.ExitCode}} {{.Config.Image}}',
      name,
    ]);
    if (res.code !== 0) return undefined;
    const [id = '', status = '', exitCodeRaw = '', image = ''] = res.stdout.trim().split(/\s+/);
    const phase = phaseFromStateStatus(status);
    return {
      name: container,
      id,
      phase,
      exitCode: phase === 'exited' && exitCodeRaw !== '' ? Number(exitCodeRaw) : undefined,
      ready: readinessTargets.get(name)?.ready,
      image: image || undefined,
    };
  }

  /** Live cgroup limits for a batch of member names, one `inspect` call for all of them (same trick `listNetworks` uses for subnets). */
  async function liveResources(names: readonly string[]): Promise<Map<string, ResourceLimits>> {
    const out = new Map<string, ResourceLimits>();
    if (names.length === 0) return out;
    const res = await call([
      'inspect',
      '--format',
      '{{.Name}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}',
      ...names,
    ]);
    if (res.code !== 0) return out; // best-effort: a Pod mid-removal must not fail the whole inspect
    for (const line of res.stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const [rawName, cpuRaw, memRaw] = line.trim().split(/\s+/);
      const name = (rawName ?? '').replace(/^\//, '');
      const cpu = nanoCpusToCpu(cpuRaw);
      const memory = bytesToMemory(memRaw);
      if (name && (cpu !== undefined || memory !== undefined)) out.set(name, { cpu, memory });
    }
    return out;
  }

  // ---- whole-Pod inspection --------------------------------------------------

  async function findPodRows(pod: string): Promise<ManagedRow[]> {
    const res = await call([
      'ps',
      '-a',
      '--no-trunc',
      '--filter',
      `label=${POD_LABEL}=${pod}`,
      '--format',
      '{{json .}}',
    ]);
    if (res.code !== 0) return [];
    return res.stdout
      .split('\n')
      .map(parsePsRow)
      .filter((r): r is ManagedRow => r !== null && r.pod === pod);
  }

  async function buildObservedPod(pod: string, rows: readonly ManagedRow[]): Promise<ObservedPod> {
    const infraRow = rows.find((r) => r.role === 'infra');
    const memberRows = rows.filter((r) => r.role === 'member');
    const ip = infraRow ? await infraIp(infraRow.name) : undefined;
    const resources = await liveResources(memberRows.map((r) => r.name));
    const containers = memberRows.map((r) => toObservedContainer(r, readinessTargets.get(r.name)?.ready));
    return {
      name: pod,
      id: infraRow?.id,
      phase: derivePodPhase(infraRow?.phase ?? 'exited', containers),
      ip,
      labels: infraRow?.labels ?? {},
      specDigest: infraRow?.specDigest,
      spec: reconstructPodSpec(infraRow, memberRows, resources),
      containers,
      at: now(),
    };
  }

  async function inspectPod(pod: string): Promise<ObservedPod | undefined> {
    const rows = await findPodRows(pod);
    return rows.length === 0 ? undefined : buildObservedPod(pod, rows);
  }

  /** Every container belonging to `pod` (sandbox and members alike), removed in one `rm -f`. Returns whether anything was there to remove. */
  async function removePodContainers(pod: string): Promise<boolean> {
    const rows = await findPodRows(pod);
    if (rows.length === 0) return false;
    const res = await call(['rm', '-f', ...rows.map((r) => r.name)]);
    if (res.code !== 0 && !isNotFound(res)) throw fail(res, `rm ${pod}`);
    for (const r of rows) {
      idIndex.delete(r.id);
      if (r.role === 'member') readinessTargets.delete(r.name);
    }
    return true;
  }

  // ---- creating containers ---------------------------------------------------

  async function runInfra(spec: PodSpec): Promise<void> {
    const res = await call(infraRunArgs(spec, sandboxImage));
    if (res.code !== 0) throw fail(res, `run ${infraName(spec.name)}`);
    const id = lastLine(res.stdout);
    if (isContainerId(id)) idIndex.set(id, { role: 'infra', pod: spec.name });
  }

  async function runMember(pod: string, spec: ContainerSpec): Promise<void> {
    const name = memberName(pod, spec.name);
    const res = await call(memberRunArgs(pod, spec));
    if (res.code !== 0) throw fail(res, `run ${name}`);
    const id = lastLine(res.stdout);
    if (isContainerId(id)) idIndex.set(id, { role: 'member', pod, container: spec.name });
    if (spec.readiness)
      readinessTargets.set(name, { pod, container: spec.name, probe: spec.readiness, ready: false });
    else readinessTargets.delete(name);
  }

  /** Creates whichever of `spec.containers` does not exist yet. Returns whether it created anything. */
  async function ensureMembers(spec: PodSpec): Promise<boolean> {
    let created = false;
    for (const c of spec.containers) {
      if (!(await inspectContainer(memberName(spec.name, c.name)))) {
        await runMember(spec.name, c);
        created = true;
      }
    }
    return created;
  }

  // ---- the Runtime methods ---------------------------------------------------

  async function createNetwork(spec: NetworkSpec): Promise<void> {
    const res = await call(['network', 'inspect', '--format', '{{.Name}}', spec.name]);
    // Idempotent, purely by presence: `ObservedNetwork` carries no digest to
    // compare against (unlike a Pod), so a Network already there -- ours or
    // not -- is used as is, exactly like `memory.ts`.
    if (res.code === 0) return;
    const created = await call(networkCreateArgs(spec));
    if (created.code !== 0) throw fail(created, `network create ${spec.name}`);
  }

  async function removeNetwork(name: string): Promise<void> {
    const res = await call(['network', 'rm', name]);
    if (res.code !== 0 && !isNotFound(res)) throw fail(res, `network rm ${name}`);
  }

  async function createPod(spec: PodSpec): Promise<void> {
    const wanted = digest(spec);
    const existing = await inspectContainer(infraName(spec.name));

    if (existing && existing.specDigest === wanted) {
      idIndex.set(existing.id, { role: 'infra', pod: spec.name });
      // The sandbox matches, but its digest covers the *whole* spec, not
      // just itself -- a crash between creating it and finishing its members
      // would leave the sandbox alone looking exactly like a fully realised
      // Pod. Heal whatever member did not make it before treating this as
      // done; if nothing was missing, this is a true no-op, same as
      // `memory.ts`.
      if (!(await ensureMembers(spec))) return;
    } else {
      if (existing) {
        // A different digest under this name: the planner wants this Pod
        // replaced (any change to a sandbox-defining field replaces the
        // whole Pod rather than mutating it -- see PLAN.md's immutability
        // model, and decision 10 for the general rule this follows). If
        // `existing` is something this adapter never labelled at all,
        // `removePodContainers` finds nothing to remove and the `run` below
        // fails honestly with "name already in use" instead of guessing.
        await removePodContainers(spec.name);
      }
      await runInfra(spec);
      for (const c of spec.containers) await runMember(spec.name, c);
    }

    const pod = await inspectPod(spec.name);
    if (pod) notify({ type: 'pod', pod });
  }

  async function removePod(name: string): Promise<void> {
    if (await removePodContainers(name)) notify({ type: 'pod-removed', name });
  }

  async function createContainer(pod: string, spec: ContainerSpec): Promise<void> {
    const name = memberName(pod, spec.name);
    if (await inspectContainer(name)) return; // idempotent, by presence -- same discipline as memory.ts
    if (!(await inspectContainer(infraName(pod)))) {
      throw new Error(`fiber-servo: cannot create container "${spec.name}": Pod "${pod}" does not exist`);
    }
    await runMember(pod, spec);
    const container = await inspectMemberContainer(pod, spec.name);
    if (container) notify({ type: 'container', pod, container });
  }

  async function removeContainer(pod: string, name: string): Promise<void> {
    const runtimeName = memberName(pod, name);
    const existing = await inspectContainer(runtimeName);
    if (!existing) return; // idempotent: nothing to remove
    const res = await call(['rm', '-f', runtimeName]);
    if (res.code !== 0 && !isNotFound(res)) throw fail(res, `rm ${runtimeName}`);
    idIndex.delete(existing.id);
    readinessTargets.delete(runtimeName);
    // No "container removed" event exists (same reasoning as memory.ts):
    // removal is observed as the container no longer appearing in the Pod's
    // own `containers` list, so the Pod is what gets re-announced.
    const observed = await inspectPod(pod);
    if (observed) notify({ type: 'pod', pod: observed });
  }

  async function updateContainerResources(
    pod: string,
    container: string,
    resources: ResourceLimits,
  ): Promise<void> {
    const res = await call(updateResourcesArgs(pod, container, resources));
    if (res.code !== 0) throw fail(res, `update ${memberName(pod, container)}`);
    // Resources are not part of ObservedContainer -- nothing here changes --
    // but a mutation happened, so subscribers still hear about it, the same
    // as a real runtime firing an update event. The next inspect() sees the
    // new limits live; see `reconstructPodSpec` in parse.ts.
    const observed = await inspectMemberContainer(pod, container);
    if (observed) notify({ type: 'container', pod, container: observed });
  }

  async function listNetworks(): Promise<Map<string, ObservedNetwork>> {
    const res = await call(['network', 'ls', '--format', '{{json .}}']);
    if (res.code !== 0) throw fail(res, 'network ls');
    const names = res.stdout
      .split('\n')
      .map((line) => parseJsonSafe<NetworkRow>(line))
      .filter((r): r is NetworkRow => r !== null && Boolean(r.Name) && isManaged(r.Labels))
      .map((r) => r.Name);
    const networks = new Map<string, ObservedNetwork>();
    if (names.length === 0) return networks;
    // One batched call for every network's subnet, same trick as `liveResources`.
    const inspected = await call([
      'network',
      'inspect',
      '--format',
      '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}',
      ...names,
    ]);
    if (inspected.code !== 0) return networks; // best-effort, same reasoning as liveResources
    for (const line of inspected.stdout.trim().split('\n')) {
      const [name, subnet] = line.trim().split(/\s+/);
      if (name) networks.set(name, { name, subnet: subnet || undefined });
    }
    return networks;
  }

  async function inspect(): Promise<ObservedState> {
    const res = await call(['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
    if (res.code !== 0) throw fail(res, 'ps -a');
    const rows = res.stdout
      .split('\n')
      .map(parsePsRow)
      .filter((r): r is ManagedRow => r !== null);

    const byPod = new Map<string, ManagedRow[]>();
    for (const r of rows) {
      idIndex.set(
        r.id,
        r.role === 'infra'
          ? { role: 'infra', pod: r.pod }
          : { role: 'member', pod: r.pod, container: r.container! },
      );
      // Recover a probe schedule this process never saw created: readiness
      // config lives nowhere in containerd except inside `SPEC_JSON_LABEL`
      // (see `parse.ts`), decoded here so a restart resumes probing instead
      // of leaving a container un-probed forever.
      if (r.role === 'member' && !readinessTargets.has(r.name)) {
        const spec = decodeSpecLabel<ContainerSpec>(r.specJson);
        if (spec?.readiness) {
          readinessTargets.set(r.name, {
            pod: r.pod,
            container: r.container!,
            probe: spec.readiness,
            ready: false,
          });
        }
      }
      const list = byPod.get(r.pod);
      if (list) list.push(r);
      else byPod.set(r.pod, [r]);
    }

    const pods = new Map<string, ObservedPod>();
    for (const [name, podRows] of byPod) pods.set(name, await buildObservedPod(name, podRows));

    return { pods, networks: await listNetworks(), revision };
  }

  // ---- events -----------------------------------------------------------------

  async function resolveId(id: string): Promise<Tracked | undefined> {
    const known = idIndex.get(id);
    if (known) return known;
    if (notOurs.has(id)) return undefined;
    const res = await call([
      'inspect',
      '--format',
      `{{index .Config.Labels "${MANAGED_LABEL}"}} {{index .Config.Labels "${POD_LABEL}"}} {{index .Config.Labels "${CONTAINER_LABEL}"}} {{index .Config.Labels "${ROLE_LABEL}"}}`,
      id,
    ]);
    if (res.code !== 0) {
      notOurs.add(id);
      return undefined;
    }
    const [managed = '', pod = '', container = '', role = ''] = res.stdout.trim().split(/\s+/);
    if (managed !== 'true' || !pod || (role !== 'infra' && role !== 'member')) {
      notOurs.add(id);
      return undefined;
    }
    const target: Tracked = role === 'infra' ? { role: 'infra', pod } : { role: 'member', pod, container };
    idIndex.set(id, target);
    return target;
  }

  async function handleEventLine(line: string): Promise<void> {
    const row = parseJsonSafe<EventRow>(line);
    if (!row?.Topic) return;
    const event = interpretEventRow(row);
    if (!event) return;
    const target = await resolveId(event.id);
    if (!target) return; // not ours

    if (target.role === 'infra') {
      if (event.kind === 'deleted') {
        idIndex.delete(event.id);
        notify({ type: 'pod-removed', name: target.pod });
        return;
      }
      // A start or exit on the sandbox changes the whole Pod's phase (see
      // `derivePodPhase`), not one field of it, so re-derive rather than patch.
      const pod = await inspectPod(target.pod);
      if (pod) notify({ type: 'pod', pod });
      else notify({ type: 'pod-removed', name: target.pod });
      return;
    }

    if (event.kind === 'deleted') {
      idIndex.delete(event.id);
      readinessTargets.delete(memberName(target.pod, target.container));
      // Same "no container-removed event" rule as removeContainer.
      const pod = await inspectPod(target.pod);
      if (pod) notify({ type: 'pod', pod });
      return;
    }
    const container = await inspectMemberContainer(target.pod, target.container);
    if (container) notify({ type: 'container', pod: target.pod, container });
  }

  async function resyncOnce(): Promise<void> {
    try {
      const state = await inspect();
      notify({ type: 'resync', state: { pods: state.pods, networks: state.networks } });
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async function runEventLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const line of nerdctl.stream(['events', '--format', '{{json .}}'], signal)) {
          await handleEventLine(line);
        }
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
      if (signal.aborted) return;
      // The stream ended on its own -- containerd restarted, nerdctl exited,
      // the socket dropped. Nothing guarantees we saw everything up to that
      // point, so resync fully and announce it before trying to reattach:
      // this is the fallback the Runtime contract asks `subscribe` for, not
      // merely a reconnect. If the stream keeps failing, this repeats, so the
      // resync is genuinely periodic for as long as it stays down.
      await resyncOnce();
      await sleep(reconnectDelayMs, signal);
    }
  }

  async function runProber(signal: AbortSignal): Promise<void> {
    const lastAttempt = new Map<string, number>();
    while (!signal.aborted) {
      const t = Date.now();
      for (const [name, target] of readinessTargets) {
        if (target.ready) continue;
        const interval = target.probe.intervalMs ?? 2000;
        if (t - (lastAttempt.get(name) ?? 0) < interval) continue;
        lastAttempt.set(name, t);
        const res = await nerdctl.exec(['exec', name, ...target.probe.exec]);
        // Only mark it once: a concurrent removal clears the target from the
        // map entirely, so a stale success cannot resurrect it.
        if (res.code === 0 && readinessTargets.get(name) === target && !target.ready) {
          target.ready = true;
          log(`ready ${name}`);
          const container = await inspectMemberContainer(target.pod, target.container);
          if (container) notify({ type: 'container', pod: target.pod, container });
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
  }

  return {
    createNetwork,
    removeNetwork,
    createPod,
    removePod,
    createContainer,
    removeContainer,
    updateContainerResources,
    inspect,
    subscribe,
    close,
  };
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
