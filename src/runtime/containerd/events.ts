/**
 * Feeds containerd lifecycle into the status store. This is the event source.
 *
 * Two inputs, both through nerdctl:
 *   - `ps -a` once at startup (and on every reconnect) so containers that
 *     already exist are adopted with their real state;
 *   - `events` as a stream, translated per containerd topic.
 *
 * Only containers carrying the fiber-servo label are reported. containerd
 * events identify containers by their 64-hex id; names come from the shared
 * index (filled by the executor and by `ps`) or, failing that, `inspect`.
 */
import type { ContainerState, StatusStore } from '../../status.js';
import { MANAGED_LABEL, type Nerdctl } from './nerdctl.js';

export interface WatchOptions {
  nerdctl: Nerdctl;
  status: StatusStore;
  /** Shared with the executor; see `ContainerdRuntimeOptions.index`. */
  index?: Map<string, string>;
  signal?: AbortSignal;
  /** Wait before re-attaching after the event stream ends. Default 1000. */
  reconnectDelayMs?: number;
  /**
   * Called after every successful `ps -a` sync, reconnects included. The first
   * call is what tells a caller that adopted containers are in the store.
   */
  onSynced?: () => void;
  log?: (line: string) => void;
  onError?: (error: Error) => void;
}

/** What one input line means for the store. */
export type StatusEvent =
  { kind: 'set'; name: string; state: ContainerState; exitCode?: number } | { kind: 'remove'; name: string };

/** One row of `nerdctl ps -a --format '{{json .}}'`. */
export interface PsRow {
  ID: string;
  Names: string;
  Status: string;
  Labels?: string;
}

/** One line of `nerdctl events --format '{{json .}}'`. */
export interface EventRow {
  ID: string;
  Topic: string;
  /** JSON of the containerd event body, encoded as a string by nerdctl. */
  Event?: string | Record<string, unknown>;
}

/** `Up 3 seconds` -> running; `Exited (137) 2 minutes ago` -> dead 137; `Created` -> dead. */
export function parsePsStatus(text: string): { state: ContainerState; exitCode?: number } {
  const s = text.trim();
  if (/^(Up|Running|Paused)\b/i.test(s)) return { state: 'running' };
  const exited = /^Exited \((-?\d+)\)/i.exec(s);
  if (exited) return { state: 'dead', exitCode: Number(exited[1]) };
  if (/^(Exited|Stopped|Created|Dead)\b/i.test(s)) return { state: 'dead' };
  return { state: 'unknown' };
}

export function isManaged(labels: string | undefined): boolean {
  return (labels ?? '').split(',').some((kv) => kv.trim() === `${MANAGED_LABEL}=true`);
}

export function parsePsLine(line: string): (StatusEvent & { id: string }) | null {
  const row = parseJson<PsRow>(line);
  if (!row || !row.Names || !isManaged(row.Labels)) return null;
  const name = row.Names.split(',')[0]!.trim();
  return { kind: 'set', name, id: row.ID, ...parsePsStatus(row.Status ?? '') };
}

/**
 * Translate an event row. `resolve` maps a containerd id to a fiber-servo name,
 * or `undefined` for containers that are not ours.
 */
export function interpretEvent(
  row: EventRow,
  resolve: (id: string) => string | undefined,
): StatusEvent | null {
  const body =
    typeof row.Event === 'string' ? (parseJson<Record<string, unknown>>(row.Event) ?? {}) : (row.Event ?? {});
  const id = String(body['container_id'] ?? row.ID ?? '');
  const name = resolve(id);
  if (!name) return null;
  switch (row.Topic) {
    case '/tasks/start':
      return { kind: 'set', name, state: 'running' };
    case '/tasks/exit': {
      // Exec processes exit too; only the init process (id == container_id) is the container.
      const pid = body['id'];
      if (pid !== undefined && pid !== body['container_id']) return null;
      return { kind: 'set', name, state: 'dead', exitCode: Number(body['exit_status'] ?? 0) };
    }
    case '/containers/delete':
      return { kind: 'remove', name };
    default:
      return null;
  }
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function apply(status: StatusStore, event: StatusEvent): void {
  if (event.kind === 'remove') status.remove(event.name);
  else
    status.set(
      event.name,
      event.state,
      event.exitCode === undefined ? undefined : { exitCode: event.exitCode },
    );
}

/** Read `ps -a` once and reflect every managed container into the store and the index. */
export async function syncFromPs(options: Pick<WatchOptions, 'nerdctl' | 'status' | 'index'>): Promise<void> {
  const res = await options.nerdctl.exec(['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
  if (res.code !== 0) throw new Error(`nerdctl ps failed (exit ${res.code}): ${res.stderr.trim()}`);
  for (const line of res.stdout.split('\n')) {
    const row = parsePsLine(line);
    if (!row) continue;
    options.index?.set(row.id, row.name);
    apply(options.status, row);
  }
}

/**
 * Run until `signal` aborts: sync, then follow the event stream, re-attaching
 * (with a fresh sync) whenever it ends.
 */
export async function watchContainerd(options: WatchOptions): Promise<void> {
  const {
    nerdctl,
    status,
    signal,
    reconnectDelayMs = 1000,
    log = () => {},
    onError = (e) => console.error(e),
    onSynced = () => {},
  } = options;
  const index = options.index ?? new Map<string, string>();
  const notOurs = new Set<string>();

  async function resolve(id: string): Promise<string | undefined> {
    const known = index.get(id);
    if (known || notOurs.has(id)) return known;
    const res = await nerdctl.exec([
      'inspect',
      '--format',
      `{{.Name}} {{index .Config.Labels "${MANAGED_LABEL}"}}`,
      id,
    ]);
    const [name = '', managed = ''] = res.code === 0 ? res.stdout.trim().split(/\s+/) : [];
    if (managed !== 'true' || !name) {
      notOurs.add(id);
      return undefined;
    }
    const clean = name.replace(/^\//, '');
    index.set(id, clean);
    return clean;
  }

  while (!signal?.aborted) {
    try {
      await syncFromPs({ nerdctl, status, index });
      onSynced();
      log('watching containerd events');
      for await (const line of nerdctl.stream(['events', '--format', '{{json .}}'], signal)) {
        const row = parseJson<EventRow>(line);
        if (!row?.Topic) continue;
        const body =
          typeof row.Event === 'string'
            ? (parseJson<Record<string, unknown>>(row.Event) ?? {})
            : (row.Event ?? {});
        const id = String(body['container_id'] ?? row.ID ?? '');
        const name = await resolve(id);
        const event = interpretEvent(row, () => name);
        if (event) {
          log(`event ${row.Topic} ${event.name}`);
          apply(status, event);
        }
      }
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
    if (signal?.aborted) return;
    await new Promise<void>((r) => {
      const t = setTimeout(r, reconnectDelayMs);
      signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
    });
  }
}
