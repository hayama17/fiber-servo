/**
 * The Compose Application Model: what fiber-servo hands to its actuator.
 *
 * This is the write path's boundary. Above it, controllers decide *what
 * application should exist*; below it, `nerdctl compose` does the pulling,
 * the network creation and the running. fiber-servo never emits a
 * create/start/stop sequence of its own.
 *
 * ## A note on the word "service"
 *
 * Compose calls a container definition a **service**. fiber-servo's
 * `<Service>` is something else entirely — a stable endpoint in front of
 * whichever containers match a selector, in the Kubernetes sense. Two
 * meanings for one word in one codebase is how a reader gets lost, so the
 * type `ComposeService` and the word "service" in that sense live in this
 * file and nowhere else. Everywhere above the runtime boundary the unit is a
 * **container**.
 *
 * ## Why the output is JSON
 *
 * A Compose file is YAML, and YAML's scalar rules are a minefield for a
 * generator: `yes`, `no`, `on`, `1.0`, `8080:80` and a value containing a
 * colon each need quoting for a different reason, and getting one wrong
 * produces a file that parses into the wrong thing rather than failing. JSON
 * is a subset of YAML, so emitting JSON sidesteps every one of those rules
 * while still being a valid Compose file. Verified against nerdctl 2.1.2: it
 * parses a JSON document handed to `compose -f` and round-trips `"yes"` and
 * `"1.0"` as the strings they are.
 */
import { digest, type ContainerSpec, type NetworkSpec, type ResourceLimits } from './resources.js';

/** Label marking every container fiber-servo owns. Anything without it is left alone. */
export const MANAGED_LABEL = 'fiber-servo.managed';

/**
 * `digest()` of the ContainerSpec a container was created from.
 *
 * This is what tells the control plane a container is out of date. It only
 * has to answer "same or different", not "which field changed": under Compose
 * the response to any difference is the same — remove that one service and
 * let `up` recreate it — so the full spec no longer needs to be carried in a
 * label at all.
 */
export const SPEC_LABEL = 'fiber-servo.spec';

/** Compose's own label for the service name, which is the name our controllers chose. */
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

/** Compose's own label for the project name. */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/** Where nerdctl records a container's networks. Read back through the containerd observer. */
export const NERDCTL_NETWORKS_LABEL = 'nerdctl/networks';

// ---- the model --------------------------------------------------------------

/** One container definition. Only the fields fiber-servo actually sets. */
export interface ComposeService {
  image: string;
  command?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  /** Network names, as declared in the application's `networks` block. */
  networks?: readonly string[];
  /** Short syntax, `"<host>:<container>"` or `"<host>:<container>/udp"`. */
  ports?: readonly string[];
  labels?: Readonly<Record<string, string>>;
  deploy?: { resources?: { limits?: { cpus?: string; memory?: string } } };
}

/**
 * A network declaration.
 *
 * `name` is always set, and deliberately: without it Compose prefixes the
 * runtime name with the project (`backend` becomes `fiber-servo_backend`),
 * and then the name written into the model no longer equals the name observed
 * back on the container. Pinning it keeps those two the same string, which is
 * one fewer thing for the reconcile comparison to know about.
 */
export interface ComposeNetwork {
  name: string;
}

export interface ComposeApplication {
  /** The Compose project. One per fiber-servo tree. */
  name: string;
  services: Readonly<Record<string, ComposeService>>;
  networks: Readonly<Record<string, ComposeNetwork>>;
}

export const DEFAULT_PROJECT = 'fiber-servo';

// ---- building it ------------------------------------------------------------

function toPorts(spec: ContainerSpec): string[] | undefined {
  if (!spec.publish?.length) return undefined;
  return spec.publish.map((p) =>
    p.protocol && p.protocol !== 'tcp' ? `${p.host}:${p.target}/${p.protocol}` : `${p.host}:${p.target}`,
  );
}

function toLimits(resources: ResourceLimits | undefined): ComposeService['deploy'] {
  if (resources === undefined) return undefined;
  const limits: { cpus?: string; memory?: string } = {};
  if (resources.cpu !== undefined) limits.cpus = String(resources.cpu);
  if (resources.memory !== undefined) limits.memory = resources.memory;
  return Object.keys(limits).length > 0 ? { resources: { limits } } : undefined;
}

/**
 * One container becomes one Compose service.
 *
 * The spec digest is computed from the *container spec*, not from the
 * rendered service, so it does not move when this mapping changes shape. A
 * reader comparing a label against a desired spec is then comparing like with
 * like.
 */
export function toComposeService(spec: ContainerSpec): ComposeService {
  const labels: Record<string, string> = {
    ...spec.labels,
    [MANAGED_LABEL]: 'true',
    [SPEC_LABEL]: digest(spec),
  };
  const service: ComposeService = { image: spec.image, labels };
  if (spec.command?.length) Object.assign(service, { command: [...spec.command] });
  if (spec.env && Object.keys(spec.env).length > 0) Object.assign(service, { environment: { ...spec.env } });
  if (spec.network) Object.assign(service, { networks: [spec.network] });
  const ports = toPorts(spec);
  if (ports) Object.assign(service, { ports });
  const deploy = toLimits(spec.resources);
  if (deploy) Object.assign(service, { deploy });
  return service;
}

/**
 * The whole desired application.
 *
 * Container names are the service names, so the names the controllers chose
 * (`api-0`, `web-43bfee23-1`) are what appear in `nerdctl compose ps` and in
 * the `com.docker.compose.service` label the observer reads back.
 */
export function toComposeApplication(
  containers: readonly ContainerSpec[],
  networks: readonly NetworkSpec[],
  project: string = DEFAULT_PROJECT,
): ComposeApplication {
  const services: Record<string, ComposeService> = {};
  for (const spec of containers) {
    if (services[spec.name]) {
      throw new Error(`fiber-servo: two containers are both named "${spec.name}"`);
    }
    services[spec.name] = toComposeService(spec);
  }

  const declared: Record<string, ComposeNetwork> = {};
  for (const network of networks) declared[network.name] = { name: network.name };
  // A container may name a network the tree never declared. Compose refuses a
  // service referencing an undeclared network, so rather than emit a file that
  // cannot be applied, declare it: the user asked to join it, and Compose
  // creates it if it is missing.
  for (const spec of containers) {
    if (spec.network && !declared[spec.network]) declared[spec.network] = { name: spec.network };
  }

  return { name: project, services, networks: declared };
}

// ---- rendering it -----------------------------------------------------------

/**
 * The file handed to `nerdctl compose -f`. JSON, for the reason in the file
 * comment; pretty-printed because it is also what `fiber-servo plan` shows a
 * human.
 */
export function renderCompose(app: ComposeApplication): string {
  return `${JSON.stringify(app, null, 2)}\n`;
}

/**
 * Which services differ from what is running.
 *
 * `recorded` maps a service name to the `fiber-servo.spec` label read back
 * from the runtime. A service that is absent is not "changed" — it simply
 * does not exist yet, and `compose up` will create it. Only a service that
 * exists with a *different* spec has to be removed first, which is exactly
 * the list `apply()` passes to `compose rm`.
 */
export function changedServices(app: ComposeApplication, recorded: ReadonlyMap<string, string>): string[] {
  const changed: string[] = [];
  for (const [name, service] of Object.entries(app.services)) {
    const was = recorded.get(name);
    if (was !== undefined && was !== service.labels?.[SPEC_LABEL]) changed.push(name);
  }
  return changed.sort();
}

/** Services running under this project that the model no longer declares. */
export function orphanedServices(app: ComposeApplication, recorded: ReadonlyMap<string, string>): string[] {
  return [...recorded.keys()].filter((name) => !(name in app.services)).sort();
}
