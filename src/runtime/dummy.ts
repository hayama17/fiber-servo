/**
 * Phase-0 runtime: prints ops and does nothing else.
 *
 * A real runtime (docker, containerd) replaces this file with one that executes
 * each op. The reconciler never knows the difference.
 */
import { formatOp, type OpSink } from '../ops.js';

export function createDummyRuntime(log: (line: string) => void = console.log): OpSink {
  let commit = 0;
  return (ops) => {
    commit += 1;
    log(`-- commit #${commit} (${ops.length} op${ops.length === 1 ? '' : 's'})`);
    for (const op of ops) log(`   ${formatOp(op)}`);
  };
}
