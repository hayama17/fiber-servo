/**
 * Ops are the *only* output of the reconciler.
 *
 * Design rule #2: the hostConfig never executes anything. Every mutation the
 * fiber tree decides on is appended synchronously to an op queue, and a
 * separate runtime (docker, containerd, or a printer) consumes it later.
 */

/** Everything a runtime needs to bring a container up. `name` is the identity. */
export interface ContainerSpec {
  name: string;
  image: string;
  command?: readonly string[];
  env?: Readonly<Record<string, string>>;
  ports?: readonly number[];
  labels?: Readonly<Record<string, string>>;
}

export type InstanceKind = 'container';

export interface CreateOp {
  type: 'CREATE';
  kind: InstanceKind;
  id: string;
  spec: ContainerSpec;
}

export interface UpdateOp {
  type: 'UPDATE';
  kind: InstanceKind;
  id: string;
  prev: ContainerSpec;
  next: ContainerSpec;
  /** Top-level spec keys whose value differs between prev and next. */
  changed: readonly (keyof ContainerSpec)[];
}

export interface DeleteOp {
  type: 'DELETE';
  kind: InstanceKind;
  id: string;
}

/**
 * Self-healing. Emitted when the tree's desired restart generation for a
 * container moves past the runtime's; `attempt` is that generation (1-based).
 */
export interface StartOp {
  type: 'START';
  kind: InstanceKind;
  id: string;
  attempt: number;
}

export type Op = CreateOp | UpdateOp | DeleteOp | StartOp;

/** A consumer of ops. Called once per React commit with the ops of that commit, in order. */
export type OpSink = (ops: readonly Op[]) => void;

const SPEC_KEYS: readonly (keyof ContainerSpec)[] = [
  'name',
  'image',
  'command',
  'env',
  'ports',
  'labels',
];

/** Structural equality for the JSON-shaped values a spec can hold. */
export function specValueEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => specValueEquals(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  return ak.length === bk.length && ak.every((k) => k in bo && specValueEquals(ao[k], bo[k]));
}

/** Returns the spec keys that differ, so an UPDATE can carry a precise diff. */
export function diffSpec(prev: ContainerSpec, next: ContainerSpec): (keyof ContainerSpec)[] {
  return SPEC_KEYS.filter((k) => !specValueEquals(prev[k], next[k]));
}

/** One-line rendering used by the dummy runtime and by test failure messages. */
export function formatOp(op: Op): string {
  switch (op.type) {
    case 'CREATE':
      return `CREATE ${op.kind} ${op.id} image=${op.spec.image}`;
    case 'UPDATE':
      return `UPDATE ${op.kind} ${op.id} changed=[${op.changed.join(',')}]`;
    case 'DELETE':
      return `DELETE ${op.kind} ${op.id}`;
    case 'START':
      return `START ${op.kind} ${op.id} attempt=${op.attempt}`;
  }
}
