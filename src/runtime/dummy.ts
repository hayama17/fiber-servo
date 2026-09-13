/**
 * Phase-0/1 runtime: prints ops and does nothing else.
 *
 * With a `status` store it also plays a runtime that always succeeds:
 * CREATE and START report `running`, DELETE forgets the container. That is
 * enough to exercise the self-healing loop end to end without docker.
 *
 * A real runtime (docker, containerd) replaces this file with one that
 * executes each op and one that feeds runtime events into the store. The
 * reconciler never knows the difference.
 */
import { formatOp, type OpSink } from '../ops.js';
import type { StatusStore } from '../status.js';

export interface DummyRuntimeOptions {
  log?: (line: string) => void;
  /** When given, ops are reflected into this store as if they had succeeded. */
  status?: StatusStore;
}

export function createDummyRuntime(options: DummyRuntimeOptions | ((line: string) => void) = {}): OpSink {
  const { log = console.log, status } = typeof options === 'function' ? { log: options } : options;
  let commit = 0;
  return (ops) => {
    commit += 1;
    log(`-- commit #${commit} (${ops.length} op${ops.length === 1 ? '' : 's'})`);
    for (const op of ops) log(`   ${formatOp(op)}`);
    if (!status) return;
    for (const op of ops) {
      if (op.kind !== 'container') continue; // networks have no status
      switch (op.type) {
        case 'CREATE':
        case 'START':
          status.set(op.id, 'running');
          break;
        case 'DELETE':
          status.remove(op.id);
          break;
        case 'UPDATE':
          break;
      }
    }
  };
}
