import type { ReactNode } from 'react';
import type { ApplyResult } from './control.js';
import { formatOp } from './ops.js';
import { serve, type ServeOptions } from './serve.js';

/** One writer for explicit apply, watch reloads, and shutdown. */
export function createSession(options: ServeOptions, load: () => Promise<ReactNode>) {
  let active: ApplyResult | undefined;
  const served = serve(null, {
    ...options,
    onOps(ops) {
      active?.ops.push(...ops.map(formatOp));
      options.onOps?.(ops);
    },
    onError(error) {
      active?.errors.push(error.message);
      options.onError?.(error);
    },
  });
  let queue = Promise.resolve();
  let stopping = false;
  let stopped: Promise<void> | undefined;
  return {
    served,
    apply(): Promise<ApplyResult> {
      if (stopping) return Promise.resolve({ ok: false, ops: [], errors: ['Session is stopping'] });
      const run = queue.then(async () => {
        // Drain previous work before attributing errors/ops to this evaluation.
        await served.idle();
        const result: ApplyResult = { ok: true, ops: [], errors: [] };
        active = result;
        try {
          let element: ReactNode;
          try {
            element = await load();
          } catch (e) {
            throw new Error(`${e instanceof Error ? e.message : String(e)} (keeping the previous tree)`);
          }
          served.root.render(element);
          await served.root.settle();
          await served.idle();
          await served.root.settle();
          await served.idle();
        } catch (e) {
          result.errors.push(e instanceof Error ? e.message : String(e));
          // A failed render may have committed deletions. Drain those too.
          await served.idle().catch((error: unknown) => result.errors.push(String(error)));
        } finally {
          active = undefined;
        }
        result.ok = result.errors.length === 0;
        return result;
      });
      queue = run.then(
        () => {},
        () => {},
      );
      return run;
    },
    stop(): Promise<void> {
      stopping = true;
      return (stopped ??= queue.then(() => served.stop()));
    },
  };
}
