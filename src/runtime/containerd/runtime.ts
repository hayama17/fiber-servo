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
 * ---- Reads on the API, writes on the CLI --------------------------------
 *
 * Creating, removing and updating containers still goes through `nerdctl`
 * (`nerdctl.ts`, `naming.ts`) -- it carries image resolution, CNI attachment
 * and port publishing that would otherwise have to be reimplemented. But
 * *reading back* what exists goes straight to containerd's own gRPC API
 * (`api.ts`), for the reasons laid out in that file's doc: no text to parse,
 * no process per read, typed events. Concretely, everywhere this file used to
 * run `nerdctl inspect --format '...'` or `nerdctl ps --format '{{json .}}'`
 * now calls `api.listContainers()` / `api.listTasks()` / `api.getContainer()`
 * instead, and `nerdctl events` is replaced by `api.subscribe`. Networks are
 * CNI configuration files, which containerd has no notion of at all, so they
 * come from `cni.ts` instead of either.
 *
 * One read stays on nerdctl regardless: a Pod's IP. See the comment above
 * `infraIp` for why -- it is a CNI result, not containerd state, and `cni.ts`
 * has no way to attribute an address to a *specific running container*.
 *
 * `ApiContainer.id` is containerd's own container id -- a generated 64-hex
 * string -- **not** the `--name` this adapter gave it at `run` time (that
 * name is just another label, `nerdctl/name`, among everything else nerdctl
 * stores as labels). So nothing here can look a container up by its runtime
 * name the way `nerdctl inspect <name>` used to; every read instead finds a
 * container by *label* (`POD_LABEL`/`ROLE_LABEL`/`CONTAINER_LABEL`, all from
 * `nerdctl.ts`) out of `api.listContainers()`'s full list. `classify` is the
 * one place that turns a container's labels into "which Pod, which role" --
 * inspecting a single Pod, inspecting one member, grouping a full resync, and
 * resolving an event's id all go through it.
 *
 * Everything else follows from having two kinds of container instead of one:
 *
 *   - `createPod` creates the sandbox, then every member, in that order (a
 *     member cannot join a namespace that does not exist yet); `removePod`
 *     removes every container carrying the Pod's `POD_LABEL`, sandbox
 *     included, found the same way `inspectPod` finds them.
 *   - Adoption is by spec digest (decision 10 in `docs/decisions.md`), same
 *     as everywhere else in this project: every resource this adapter
 *     creates is labelled with `digest(spec)` of *that resource's own*
 *     spec -- the whole `PodSpec` on the sandbox, one `ContainerSpec` per
 *     member -- so a restarted process recognises what it already made
 *     instead of recreating it.
 *   - `ObservedPod.spec` is reconstructed from labels too, but *not* simply
 *     read back from one label -- see the comment above `reconstructPodSpec`
 *     in `parse.ts` for why, and for a live-resources caveat that reading
 *     from the API (rather than `nerdctl inspect`) introduces.
 *
 * ---- Staying observable without trusting one source forever ------------
 *
 * `subscribe()` streams `api.subscribe` and translates events as they
 * arrive, but a process that only ever streamed would go blind the moment
 * that stream ends (containerd restarting, the socket dropping) without
 * knowing what it missed. So the event loop resyncs fully with one
 * `inspect()` and emits it as a `resync` event both when a subscriber first
 * attaches and on any such end, before it tries to reattach -- see
 * `runEventLoop`. `api.subscribe`'s only signal that the stream is over is
 * `onError` (there is no separate "ended cleanly" callback), so that is what
 * reattachment keys off. The readiness prober runs alongside it, `nerdctl
 * exec`-ing each container's probe until it exits 0 (decision 15) -- probing
 * is not a state read, it is asking the container a question, which is not
 * something containerd's API does on this project's behalf.
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
  SPEC_JSON_LABEL,
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
import type { ApiContainer, ApiEvent, ApiTask, ContainerdApi } from './api.js';
import { listNetworks as listCniNetworks, type CniOptions } from './cni.js';
import {
  decodeSpecLabel,
  derivePodPhase,
  phaseFromTask,
  reconstructPodSpec,
  toObservedContainer,
} from './parse.js';

export interface ContainerdRuntimeOptions {
  /** The process-execution seam for writes; see `nerdctl.ts`. Tests inject a fake here. */
  nerdctl: Nerdctl;
  /** The gRPC read seam; see `api.ts`. Tests inject a fake here too. */
  api: ContainerdApi;
  /** Where networks are read from; see `cni.ts`. Default: `cni.ts`'s own defaults. */
  cni?: CniOptions;
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

/** What the id index remembers about one containerd id, so an event can be resolved without a list call on the hot path. */
type Tracked = { role: 'infra'; pod: string } | { role: 'member'; pod: string; container: string };

interface ReadinessTarget {
  pod: string;
  container: string;
  probe: NonNullable<ContainerSpec['readiness']>;
  /** Local latch: once true, the prober leaves this container alone until it is recreated. */
  ready: boolean;
}

export function createContainerdRuntime(options: ContainerdRuntimeOptions): Runtime {
  const { nerdctl, api } = options;
  const cniOptions = options.cni ?? {};
  const sandboxImage = options.sandboxImage ?? DEFAULT_SANDBOX_IMAGE;
  const log = options.log ?? (() => {});
  const onError = options.onError ?? ((e: Error) => console.error(e));
  const probeTickMs = options.probeTickMs ?? 250;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  const now = options.now ?? (() => Date.now());

  /** containerd id -> what it is. Populated by every `run` this process does, and by every list/inspect sync. */
  const idIndex = new Map<string, Tracked>();
  /** Ids confirmed to carry no fiber-servo label, cached so a foreign container is looked up at most once. */
  const notOurs = new Set<string>();
  /** Runtime member name -> its readiness schedule. The only place probe config lives; see `parse.ts`'s recorded-spec note. */
  const readinessTargets = new Map<string, ReadinessTarget>();
  const listeners = new Set<RuntimeEventListener>();
  let controller: AbortController | undefined;
  let revision = 0;

  // ---- process execution (writes only) ---------------------------------------

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

  // ---- reading containers -----------------------------------------------------

  /**
   * What one `ApiContainer`'s labels say it is, or `undefined` for a
   * container this adapter does not own (no `MANAGED_LABEL`) or whose labels
   * do not describe a recognisable role -- foreign to fiber-servo either way.
   * The one place a container's labels turn into "which Pod, which role":
   * every lookup in this file goes through it rather than re-reading labels
   * itself.
   */
  function classify(container: ApiContainer): Tracked | undefined {
    if (container.labels[MANAGED_LABEL] !== 'true') return undefined;
    const pod = container.labels[POD_LABEL];
    const role = container.labels[ROLE_LABEL];
    if (!pod) return undefined;
    if (role === 'infra') return { role: 'infra', pod };
    if (role === 'member') {
      const memberOf = container.labels[CONTAINER_LABEL];
      return memberOf ? { role: 'member', pod, container: memberOf } : undefined;
    }
    return undefined;
  }

  function findInfra(containers: readonly ApiContainer[], pod: string): ApiContainer | undefined {
    return containers.find((c) => {
      const t = classify(c);
      return t?.role === 'infra' && t.pod === pod;
    });
  }

  function findMember(
    containers: readonly ApiContainer[],
    pod: string,
    container: string,
  ): ApiContainer | undefined {
    return containers.find((c) => {
      const t = classify(c);
      return t?.role === 'member' && t.pod === pod && t.container === container;
    });
  }

  function podRows(containers: readonly ApiContainer[], pod: string): ApiContainer[] {
    return containers.filter((c) => classify(c)?.pod === pod);
  }

  /**
   * The Pod's IP address -- the one read left on `nerdctl`, and the only one.
   * Every other read in this file goes through `api.ts` because it is pure
   * containerd state; an address is not. It is CNI's doing (the bridge plugin
   * assigns it from the network's IPAM range when the sandbox's namespace is
   * created), and while `cni.ts` can read a *network's* subnet from its
   * conflist, nothing on disk records which address CNI actually handed to
   * *this* container -- that fact only exists in nerdctl's own container
   * state, which is exactly what `NetworkSettings.IPAddress` reports. There is
   * no containerd API to ask instead, so this is not a shortcut: it is the
   * only source there is.
   */
  async function infraIp(name: string): Promise<string | undefined> {
    const res = await call(['inspect', '--format', '{{.NetworkSettings.IPAddress}}', name]);
    if (res.code !== 0) return undefined;
    return res.stdout.trim() || undefined;
  }

  async function inspectMemberContainer(
    pod: string,
    container: string,
  ): Promise<ObservedContainer | undefined> {
    const [containers, tasks] = await Promise.all([api.listContainers(), api.listTasks()]);
    const row = findMember(containers, pod, container);
    if (!row) return undefined;
    const task = tasks.find((t) => t.id === row.id);
    return toObservedContainer(row, task, readinessTargets.get(memberName(pod, container))?.ready);
  }

  // ---- whole-Pod inspection --------------------------------------------------

  async function buildObservedPod(
    pod: string,
    rows: readonly ApiContainer[],
    tasks: readonly ApiTask[],
  ): Promise<ObservedPod> {
    const infraRow = rows.find((r) => classify(r)?.role === 'infra');
    const memberRows = rows.filter((r) => classify(r)?.role === 'member');
    const taskById = new Map(tasks.map((t) => [t.id, t] as const));
    const infraPhase = infraRow ? phaseFromTask(taskById.get(infraRow.id)).phase : 'exited';
    const containers = memberRows.map((r) => {
      const memberOf = classify(r);
      const name = memberOf?.role === 'member' ? memberOf.container : r.id;
      return toObservedContainer(r, taskById.get(r.id), readinessTargets.get(memberName(pod, name))?.ready);
    });
    const ip = infraRow ? await infraIp(infraName(pod)) : undefined;
    const template = decodeSpecLabel<PodSpec>(infraRow?.labels[SPEC_JSON_LABEL]);
    return {
      name: pod,
      id: infraRow?.id,
      phase: derivePodPhase(infraPhase, containers),
      ip,
      labels: template?.labels ?? {},
      specDigest: infraRow?.labels[SPEC_LABEL],
      spec: reconstructPodSpec(template, memberRows),
      containers,
      at: now(),
    };
  }

  async function inspectPod(pod: string): Promise<ObservedPod | undefined> {
    const [containers, tasks] = await Promise.all([api.listContainers(), api.listTasks()]);
    const rows = podRows(containers, pod);
    return rows.length === 0 ? undefined : buildObservedPod(pod, rows, tasks);
  }

  /** Every container belonging to `pod` (sandbox and members alike), removed in one `rm -f`. Returns whether anything was there to remove. */
  async function removePodContainers(pod: string): Promise<boolean> {
    const containers = await api.listContainers();
    const rows = podRows(containers, pod);
    if (rows.length === 0) return false;
    const res = await call(['rm', '-f', ...rows.map((r) => r.id)]);
    if (res.code !== 0 && !isNotFound(res)) throw fail(res, `rm ${pod}`);
    for (const r of rows) {
      idIndex.delete(r.id);
      const t = classify(r);
      if (t?.role === 'member') readinessTargets.delete(memberName(pod, t.container));
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
    const containers = await api.listContainers();
    let created = false;
    for (const c of spec.containers) {
      if (!findMember(containers, spec.name, c.name)) {
        await runMember(spec.name, c);
        created = true;
      }
    }
    return created;
  }

  // ---- the Runtime methods ---------------------------------------------------
  //
  // `createNetwork`/`removeNetwork` are writes and stay exactly as they were:
  // still `nerdctl network create`/`rm`, existence still checked with
  // `nerdctl network inspect`. containerd has no notion of a network at all,
  // so there is no API read to move this to -- see the file doc.

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
    const containers = await api.listContainers();
    const existing = findInfra(containers, spec.name);

    if (existing && existing.labels[SPEC_LABEL] === wanted) {
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
    const containers = await api.listContainers();
    if (findMember(containers, pod, spec.name)) return; // idempotent, by presence -- same discipline as memory.ts
    if (!findInfra(containers, pod)) {
      throw new Error(`fiber-servo: cannot create container "${spec.name}": Pod "${pod}" does not exist`);
    }
    await runMember(pod, spec);
    const container = await inspectMemberContainer(pod, spec.name);
    if (container) notify({ type: 'container', pod, container });
  }

  async function removeContainer(pod: string, name: string): Promise<void> {
    const containers = await api.listContainers();
    const existing = findMember(containers, pod, name);
    if (!existing) return; // idempotent: nothing to remove
    const runtimeName = memberName(pod, name);
    const res = await call(['rm', '-f', existing.id]);
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
    // as a real runtime firing an update event. See `reconstructPodSpec` in
    // parse.ts for why the *next* inspect() does not see the new limits live.
    const observed = await inspectMemberContainer(pod, container);
    if (observed) notify({ type: 'container', pod, container: observed });
  }

  async function inspect(): Promise<ObservedState> {
    const [allContainers, tasks, networks] = await Promise.all([
      api.listContainers(),
      api.listTasks(),
      listCniNetworks(cniOptions),
    ]);

    const byPod = new Map<string, ApiContainer[]>();
    for (const c of allContainers) {
      const target = classify(c);
      if (!target) continue;
      idIndex.set(c.id, target);
      // Recover a probe schedule this process never saw created: readiness
      // config lives nowhere in containerd except inside `SPEC_JSON_LABEL`,
      // decoded here so a restart resumes probing instead of leaving a
      // container un-probed forever.
      if (target.role === 'member') {
        const name = memberName(target.pod, target.container);
        if (!readinessTargets.has(name)) {
          const spec = decodeSpecLabel<ContainerSpec>(c.labels[SPEC_JSON_LABEL]);
          if (spec?.readiness) {
            readinessTargets.set(name, {
              pod: target.pod,
              container: target.container,
              probe: spec.readiness,
              ready: false,
            });
          }
        }
      }
      const list = byPod.get(target.pod);
      if (list) list.push(c);
      else byPod.set(target.pod, [c]);
    }

    const pods = new Map<string, ObservedPod>();
    for (const [name, rows] of byPod) pods.set(name, await buildObservedPod(name, rows, tasks));

    return { pods, networks, revision };
  }

  // ---- events -----------------------------------------------------------------

  async function resolveId(id: string): Promise<Tracked | undefined> {
    const known = idIndex.get(id);
    if (known) return known;
    if (notOurs.has(id)) return undefined;
    const container = await api.getContainer(id);
    const target = container ? classify(container) : undefined;
    if (!target) {
      notOurs.add(id);
      return undefined;
    }
    idIndex.set(id, target);
    return target;
  }

  /**
   * `/tasks/start`, `/tasks/exit` and `/tasks/delete` all concern one
   * container's task, and all three are handled the same way: find out what
   * the container is now, and say so. There is no "deleted" branch for a task
   * event, because a task being gone does not mean the *container* is --
   * `no task -> exited` (`phaseFromTask` in parse.ts) covers that case as
   * just another phase, and if the container really is gone too, `inspectPod`
   * simply will not find it and this falls through to `pod-removed`.
   */
  async function handleTaskEvent(containerId: string): Promise<void> {
    const target = await resolveId(containerId);
    if (!target) return; // not ours
    if (target.role === 'infra') {
      const pod = await inspectPod(target.pod);
      if (pod) notify({ type: 'pod', pod });
      else notify({ type: 'pod-removed', name: target.pod });
      return;
    }
    const container = await inspectMemberContainer(target.pod, target.container);
    if (container) notify({ type: 'container', pod: target.pod, container });
  }

  /**
   * `/containers/delete` means a container is gone, but -- verified against a
   * real daemon -- `api.ts`'s event decoder cannot actually tell us *which*
   * one: `ContainerDelete`'s field is named `id` (see `protos/events/container.proto`),
   * while the decoder only ever reads `container_id`, so `event.containerId`
   * is unconditionally `undefined` for this topic. There is no id to resolve
   * through the id index because the event never carries one.
   *
   * What is still true is the id *index* itself: every container this
   * process still thinks is live was put there by a `run` or a list call, so
   * a fresh `listContainers()` diffed against it tells us precisely which of
   * *our* containers just disappeared -- no guessing, no broad resync of
   * things that did not change. (Foreign containers this process never
   * tracked are correctly not reported; it never knew about them either way.)
   */
  async function reconcileDeletion(): Promise<void> {
    const containers = await api.listContainers();
    const present = new Set(containers.map((c) => c.id));
    const removedInfraPods = new Set<string>();
    const removedMembers: { pod: string; container: string }[] = [];
    for (const [id, target] of idIndex) {
      if (present.has(id)) continue;
      idIndex.delete(id);
      if (target.role === 'infra') removedInfraPods.add(target.pod);
      else removedMembers.push({ pod: target.pod, container: target.container });
    }
    for (const [name, target] of readinessTargets) {
      if (removedInfraPods.has(target.pod)) readinessTargets.delete(name);
    }
    for (const pod of removedInfraPods) notify({ type: 'pod-removed', name: pod });
    for (const { pod, container } of removedMembers) {
      if (removedInfraPods.has(pod)) continue; // already reported as pod-removed
      readinessTargets.delete(memberName(pod, container));
      const observed = await inspectPod(pod);
      if (observed) notify({ type: 'pod', pod: observed });
    }
  }

  async function handleApiEvent(event: ApiEvent): Promise<void> {
    switch (event.topic) {
      case '/tasks/start':
      case '/tasks/exit':
      case '/tasks/delete':
        // An event whose payload this process could not decode (see api.ts's
        // own comment on that) is still worth acting on by resyncing fully,
        // the same fallback a dead stream gets below.
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
      notify({ type: 'resync', state: { pods: state.pods, networks: state.networks } });
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * Attach to the event stream once, and resolve when it ends or is aborted.
   *
   * Events arrive already serialised: `api.subscribe` waits for each handler
   * to settle before delivering the next (see its contract in `api.ts`, and
   * the out-of-order teardown it was added to prevent). All this has to do is
   * route a handler failure to `finish`, which tears the attachment down so
   * `runEventLoop` can resync and reattach.
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
      // reattach: this is the fallback the Runtime contract asks `subscribe`
      // for, not merely a reconnect. If the stream keeps failing, this
      // repeats, so the resync is genuinely periodic for as long as it stays
      // down.
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
    api.close();
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
