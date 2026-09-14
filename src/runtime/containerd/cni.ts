/**
 * Networks, read from where they actually live.
 *
 * containerd does not know what a network is. It runs containers; attaching
 * one to a bridge is CNI's job, and nerdctl's networks are CNI configuration
 * files on disk — nothing more. Creating or deleting one produces no
 * containerd event at all, which is why `api.ts` has nothing to say about
 * them and this file exists instead.
 *
 * The layout, confirmed against nerdctl 2.1.2:
 *
 *   /etc/cni/net.d/<containerd namespace>/nerdctl-<name>.conflist
 *
 * and inside it the fields this project needs:
 *
 *   { "name": "backend",
 *     "nerdctlLabels": { ... },
 *     "plugins": [ { "ipam": { "ranges": [[{ "subnet": "...", "gateway": "..." }]] } } ] }
 *
 * Reading the files rather than shelling out to `nerdctl network ls` is the
 * same trade the rest of the read path makes: one source of truth, parsed as
 * the structured data it already is, with no CLI wording in between.
 *
 * Creating and removing networks still goes through nerdctl, which does more
 * than write this file — it allocates the bridge name and the subnet, and
 * tears the interface down again.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObservedNetwork } from '../types.js';

/** Where nerdctl keeps CNI configuration, matching its own default. */
export const DEFAULT_CNI_PATH = '/etc/cni/net.d';

/** The prefix nerdctl gives the files it owns. Anything else in the directory is someone else's. */
const NERDCTL_PREFIX = 'nerdctl-';

/**
 * Networks nerdctl always offers and never writes a file for. Without them a
 * tree that says `network="host"` would look to the planner like a network
 * that does not exist, and every pass would try to create one.
 */
export const BUILT_IN_NETWORKS: readonly string[] = ['host', 'none'];

export interface CniOptions {
  /** Root of the CNI configuration tree. Default `/etc/cni/net.d`. */
  cniPath?: string;
  /** containerd namespace, which is also the subdirectory name. Default `default`. */
  namespace?: string;
}

interface Conflist {
  name?: string;
  nerdctlLabels?: Record<string, string> | null;
  plugins?: { ipam?: { ranges?: { subnet?: string; gateway?: string }[][] } }[];
}

/** The first subnet the config declares, which is the only one a Pod can be given. */
function subnetOf(config: Conflist): string | undefined {
  for (const plugin of config.plugins ?? []) {
    const range = plugin.ipam?.ranges?.[0]?.[0];
    if (range?.subnet) return range.subnet;
  }
  return undefined;
}

/**
 * Every network visible in this namespace.
 *
 * A directory that does not exist yet is not an error: it means no network has
 * been created, which is a perfectly ordinary state for a fresh machine and
 * must not fail a reconcile.
 */
export async function listNetworks(options: CniOptions = {}): Promise<Map<string, ObservedNetwork>> {
  const dir = join(options.cniPath ?? DEFAULT_CNI_PATH, options.namespace ?? 'default');
  const networks = new Map<string, ObservedNetwork>();
  for (const name of BUILT_IN_NETWORKS) networks.set(name, { name });

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return networks;
  }

  for (const entry of entries) {
    if (!entry.startsWith(NERDCTL_PREFIX) || !entry.endsWith('.conflist')) continue;
    let config: Conflist;
    try {
      config = JSON.parse(await readFile(join(dir, entry), 'utf8')) as Conflist;
    } catch {
      // A half-written or hand-edited file is not a reason to fail the whole
      // reconcile; the network simply does not appear, and the control loop
      // treats it as absent.
      continue;
    }
    // Trust the `name` inside the file over the filename: the file is what
    // CNI reads, so it is what the runtime will actually match against.
    const name = config.name ?? entry.slice(NERDCTL_PREFIX.length, -'.conflist'.length);
    const subnet = subnetOf(config);
    networks.set(name, subnet === undefined ? { name } : { name, subnet });
  }
  return networks;
}
