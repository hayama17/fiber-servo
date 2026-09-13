/**
 * The OCI runtime spec, by hand.
 *
 * This is the part nerdctl hides most completely. containerd's Containers
 * service stores `spec` as an opaque Any and validates nothing: whatever is
 * in there is handed to the shim and then to runc. There is no default. If
 * the spec has no `process.args`, no container starts and the error comes
 * from runc, late.
 *
 * What is below is a transcription of what containerd's Go `oci` package
 * fills in for a caller (pkg/oci/spec.go `populateDefaultUnixSpec` and
 * pkg/oci/mounts.go `defaultMounts`, containerd 2.3.5), plus the parts
 * `WithImageConfig` copies out of the image config. Everything here is
 * something a JS client has to write and keep in step with containerd
 * releases; see docs/grpc-design.md for the list of what is still missing
 * (user namespaces, cgroup resources, seccomp, apparmor, devices, hostname
 * and /etc/hosts, and anything platform-specific).
 */

export interface OciMount {
  destination: string;
  type?: string;
  source?: string;
  options?: string[];
}

export interface OciSpec {
  ociVersion: string;
  process: {
    args: string[];
    env: string[];
    cwd: string;
    terminal: boolean;
    user: { uid: number; gid: number };
    noNewPrivileges: boolean;
    capabilities: {
      bounding: string[];
      effective: string[];
      permitted: string[];
    };
    rlimits: { type: string; hard: number; soft: number }[];
  };
  root: { path: string; readonly: boolean };
  hostname?: string;
  mounts: OciMount[];
  linux: {
    cgroupsPath: string;
    namespaces: { type: string; path?: string }[];
    maskedPaths: string[];
    readonlyPaths: string[];
    resources: { devices: { allow: boolean; access: string }[] };
  };
}

/** containerd 2.3.5 pkg/oci `defaultUnixCaps()`. */
export const DEFAULT_CAPS = [
  'CAP_CHOWN',
  'CAP_DAC_OVERRIDE',
  'CAP_FSETID',
  'CAP_FOWNER',
  'CAP_MKNOD',
  'CAP_NET_RAW',
  'CAP_SETGID',
  'CAP_SETUID',
  'CAP_SETFCAP',
  'CAP_SETPCAP',
  'CAP_NET_BIND_SERVICE',
  'CAP_SYS_CHROOT',
  'CAP_KILL',
  'CAP_AUDIT_WRITE',
];

/** containerd 2.3.5 pkg/oci `defaultMounts()`. */
export const DEFAULT_MOUNTS: OciMount[] = [
  { destination: '/proc', type: 'proc', source: 'proc', options: ['nosuid', 'noexec', 'nodev'] },
  {
    destination: '/dev',
    type: 'tmpfs',
    source: 'tmpfs',
    options: ['nosuid', 'strictatime', 'mode=755', 'size=65536k'],
  },
  {
    destination: '/dev/pts',
    type: 'devpts',
    source: 'devpts',
    options: ['nosuid', 'noexec', 'newinstance', 'ptmxmode=0666', 'mode=0620', 'gid=5'],
  },
  {
    destination: '/dev/shm',
    type: 'tmpfs',
    source: 'shm',
    options: ['nosuid', 'noexec', 'nodev', 'mode=1777', 'size=65536k'],
  },
  { destination: '/dev/mqueue', type: 'mqueue', source: 'mqueue', options: ['nosuid', 'noexec', 'nodev'] },
  { destination: '/sys', type: 'sysfs', source: 'sysfs', options: ['nosuid', 'noexec', 'nodev', 'ro'] },
  {
    destination: '/run',
    type: 'tmpfs',
    source: 'tmpfs',
    options: ['nosuid', 'strictatime', 'mode=755', 'size=65536k'],
  },
];

const DEFAULT_MASKED_PATHS = [
  '/proc/acpi',
  '/proc/asound',
  '/proc/kcore',
  '/proc/keys',
  '/proc/latency_stats',
  '/proc/timer_list',
  '/proc/timer_stats',
  '/proc/sched_debug',
  '/sys/firmware',
  '/sys/devices/virtual/powercap',
  '/proc/scsi',
];

const DEFAULT_READONLY_PATHS = ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'];

/** The part of an OCI image config a spec needs. Read from the image's config blob. */
export interface ImageConfig {
  Entrypoint?: string[];
  Cmd?: string[];
  Env?: string[];
  WorkingDir?: string;
  User?: string;
}

export interface SpecInput {
  /** containerd container id; also the cgroup leaf and the default hostname. */
  id: string;
  namespace: string;
  /** From the image config blob. Without it, `command` must be complete. */
  image?: ImageConfig;
  command?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

/**
 * The minimum viable config.json for `io.containerd.runc.v2`, with
 * containerd's own defaults filled in.
 */
export function buildSpec(input: SpecInput): OciSpec {
  const image = input.image ?? {};
  const args = [...(input.command ?? []), ...(input.command?.length ? [] : entrypoint(image))];
  if (args.length === 0) {
    throw new Error(
      `container ${input.id}: no process.args; the image config supplies Entrypoint/Cmd and containerd does not read it for you`,
    );
  }
  return {
    ociVersion: '1.2.0',
    process: {
      args,
      env: mergeEnv(
        image.Env ?? ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
        input.env,
      ),
      cwd: image.WorkingDir || '/',
      terminal: false,
      user: { uid: 0, gid: 0 },
      noNewPrivileges: true,
      capabilities: { bounding: DEFAULT_CAPS, effective: DEFAULT_CAPS, permitted: DEFAULT_CAPS },
      rlimits: [{ type: 'RLIMIT_NOFILE', hard: 1024, soft: 1024 }],
    },
    root: { path: 'rootfs', readonly: false },
    hostname: input.id,
    mounts: DEFAULT_MOUNTS,
    linux: {
      // containerd: filepath.Join("/", namespace, id)
      cgroupsPath: `/${input.namespace}/${input.id}`,
      namespaces: [{ type: 'pid' }, { type: 'ipc' }, { type: 'uts' }, { type: 'mount' }, { type: 'network' }],
      maskedPaths: DEFAULT_MASKED_PATHS,
      readonlyPaths: DEFAULT_READONLY_PATHS,
      resources: { devices: [{ allow: false, access: 'rwm' }] },
    },
  };
}

function entrypoint(image: ImageConfig): string[] {
  return [...(image.Entrypoint ?? []), ...(image.Cmd ?? [])];
}

/** Image env first, spec env wins, both as `K=V` the way runc wants them. */
function mergeEnv(imageEnv: readonly string[], env: Readonly<Record<string, string>> | undefined): string[] {
  const merged = new Map<string, string>();
  for (const entry of imageEnv) {
    const eq = entry.indexOf('=');
    if (eq > 0) merged.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  for (const [key, value] of Object.entries(env ?? {})) merged.set(key, value);
  return [...merged].map(([key, value]) => `${key}=${value}`);
}
