/**
 * Where a Deployment's past template generations are remembered.
 *
 * ## Why this file exists at all
 *
 * `expandDeployment` is a pure function of the *current* `DeploymentSpec`, and
 * a Deployment carries one template — the one you wrote — not a history of
 * them. During a rollout it nonetheless has to say what the *previous*
 * generation's containers should look like, because a container that dies
 * mid-drain has to come back as the thing it was, not as an approximation of
 * it. So the mapping `generation -> ContainerTemplate` has to live somewhere
 * outside the React tree and outside the controllers.
 *
 * ## Why not on the container, where it obviously belongs
 *
 * It was, briefly: a `fiber-servo.template` label holding the whole template.
 * That is the right instinct — state on the resource cannot desynchronise
 * from the resource, which is the argument decision 26 makes for
 * `fiber-servo.spec` — and it is not available here, because containerd
 * refuses it. Measured against containerd 2.2.2:
 *
 *   label key+value of 6015 bytes  -> create fails, "label key and value
 *                                     length (6015 bytes) greater than
 *                                     maximum size (4096 bytes)"
 *   two labels of 3000 bytes each  -> accepted
 *
 * So the cap is 4096 bytes *per pair*, not across the set. A container spec
 * with a few kilobytes of environment is entirely legal and entirely
 * ordinary, and encoding it into one label made it impossible to create. A
 * feature that turns a valid spec into an unlaunchable one is not a trade —
 * it is a bug, and the fix is to stop putting unbounded data in a bounded
 * place. The labels keep only what is small and fixed-width: who owns the
 * container, which generation it belongs to, and the digest of its spec.
 *
 * ## What is lost by moving it here, stated plainly
 *
 * Coupling. A label travels with the container and cannot go missing while
 * the container exists; a file beside it can. If this store is lost — a fresh
 * machine, a cleared state directory — a generation becomes unrecoverable.
 *
 * That window is narrower than it first looks. The store is consulted only
 * for generations *other than the one currently declared*, so an application
 * that is not mid-rollout never reads it: the current template comes from the
 * tree, as it always did. It matters only for a rollout that was in flight
 * when fiber-servo stopped, and even then the consequence is that the old
 * generation drains immediately instead of gradually — the new generation is
 * already ramping. `expandDeployment` refuses to invent a template for a
 * generation it cannot recover (see `recoverTemplate` there), so the failure
 * mode is "the rollout finishes sooner", never "a container comes back as
 * something nobody asked for".
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { shortDigest, type ContainerTemplate } from './resources.js';

/**
 * The read side is a plain map, which is what the controllers take: they stay
 * pure functions of (desired, observed, generations), and nothing about them
 * has to know whether the map came from a file, a test, or nowhere.
 */
export type Generations = ReadonlyMap<string, ContainerTemplate>;

export interface GenerationStore {
  /** Record a template under its own generation id. Idempotent; writes only when something changed. */
  remember(template: ContainerTemplate): void;
  /** Everything known right now, to hand to the controllers. */
  all(): Generations;
  /** Drop every generation not in `keep`, so the store does not grow for ever. */
  prune(keep: Iterable<string>): void;
}

/** Where a file-backed store lives by default, for a given Compose project. */
export function defaultGenerationsPath(project: string): string {
  const base = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');
  return join(base, 'fiber-servo', `${project}.generations.json`);
}

/** A store that remembers nothing across processes. The default in tests, and for `fiber-servo plan`. */
export function createMemoryGenerationStore(): GenerationStore {
  const templates = new Map<string, ContainerTemplate>();
  return {
    remember(template) {
      templates.set(shortDigest(template), template);
    },
    all: () => templates,
    prune(keep) {
      const kept = new Set(keep);
      for (const generation of [...templates.keys()]) {
        if (!kept.has(generation)) templates.delete(generation);
      }
    },
  };
}

export interface GenerationStoreOptions {
  path: string;
  log?: (line: string) => void;
  onError?: (error: Error) => void;
}

/**
 * A store backed by one small JSON file.
 *
 * Single node, single writer — the same assumption the rest of the project
 * makes (one fiber-servo per machine per project; see `docs/containerd.md`) —
 * so there is no locking and none is pretended. Writes are atomic against a
 * crash, not against a second writer: the file is written beside its
 * destination and renamed over it, so a reader never sees half a file.
 *
 * Every failure here is survivable and none of them stop the control loop: a
 * store that cannot be read starts empty, and a store that cannot be written
 * still holds everything in memory for this process. Losing it costs a
 * rollout its gradualness, never its correctness.
 */
export function createGenerationStore(options: GenerationStoreOptions): GenerationStore {
  const { path } = options;
  const log = options.log ?? (() => {});
  const onError = options.onError ?? (() => {});
  const templates = load();

  function load(): Map<string, ContainerTemplate> {
    const loaded = new Map<string, ContainerTemplate>();
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return loaded; // no file yet: the ordinary first run
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      for (const [generation, template] of Object.entries(parsed as Record<string, unknown>)) {
        // Each entry is checked against the id it is filed under, the same
        // way `expandDeployment` checks a recovered template: the generation
        // *is* the digest of the template, so disagreement means this entry
        // is not what it claims and is dropped rather than trusted.
        if (
          template !== null &&
          typeof template === 'object' &&
          typeof (template as ContainerTemplate).image === 'string' &&
          shortDigest(template) === generation
        ) {
          loaded.set(generation, template as ContainerTemplate);
        } else {
          log(`ignoring generation ${generation} in ${path}: it is not the template it is filed under`);
        }
      }
    } catch (e) {
      // A corrupt file is not worth failing to start over. Starting empty
      // costs an in-flight rollout its gradualness; refusing to run costs
      // the whole application.
      log(`ignoring unreadable generation store ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return loaded;
  }

  function save(): void {
    const body = `${JSON.stringify(Object.fromEntries(templates), null, 2)}\n`;
    const temp = `${path}.${String(process.pid)}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(temp, body, { mode: 0o600 });
      renameSync(temp, path);
    } catch (e) {
      // In memory it is still correct for this process; only a restart would
      // notice. Report it rather than throwing into the control loop.
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  return {
    remember(template) {
      const generation = shortDigest(template);
      if (templates.has(generation)) return; // already recorded: the common case, every pass
      templates.set(generation, template);
      save();
    },
    all: () => templates,
    prune(keep) {
      const kept = new Set(keep);
      let removed = false;
      for (const generation of [...templates.keys()]) {
        if (kept.has(generation)) continue;
        templates.delete(generation);
        removed = true;
      }
      if (removed) save();
    },
  };
}
