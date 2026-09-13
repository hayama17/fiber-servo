/**
 * A runtime that prints ops and does nothing else.
 *
 * With a `status` store it also plays a runtime that always succeeds:
 * CREATE and START report `running` (and `ready`, for containers with a
 * probe), DELETE forgets the container. That is enough to exercise every
 * loop end to end without containerd, and it is what `fiber-servo plan`
 * uses to expand gated subtrees.
 */
import { formatOp, type ContainerSpec, type OpSink } from '../ops.js';
import type { Runtime } from '../serve.js';
import type { StatusStore } from '../status.js';

export interface DummyRuntimeOptions {
  log?: (line: string) => void;
  /** When given, ops are reflected into this store as if they had succeeded. */
  status?: StatusStore;
}

export function createDummyRuntime(options: DummyRuntimeOptions | ((line: string) => void) = {}): OpSink {
  const { log = console.log, status } = typeof options === 'function' ? { log: options } : options;
  const specs = new Map<string, ContainerSpec>();
  let commit = 0;
  const up = (id: string): void => {
    status?.set(id, 'running');
    if (specs.get(id)?.readiness) status?.mark(id, { ready: true });
  };
  return (ops) => {
    commit += 1;
    log(`-- commit #${commit} (${ops.length} op${ops.length === 1 ? '' : 's'})`);
    for (const op of ops) log(`   ${formatOp(op)}`);
    for (const op of ops) {
      if (op.kind !== 'container') continue; // networks have no status
      switch (op.type) {
        case 'CREATE':
          specs.set(op.id, op.spec);
          up(op.id);
          break;
        case 'UPDATE':
          specs.set(op.id, op.next);
          break;
        case 'START':
          up(op.id);
          break;
        case 'DELETE':
          specs.delete(op.id);
          status?.remove(op.id);
          break;
      }
    }
  };
}

/** The dummy runtime as a `Runtime` for `serve()`. */
export function dummy(options: Pick<DummyRuntimeOptions, 'log'> = {}): Runtime {
  return (ctx) => ({ sink: createDummyRuntime({ log: options.log ?? ctx.log, status: ctx.status }) });
}
