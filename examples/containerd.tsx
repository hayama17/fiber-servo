/**
 * Real runtime: containerd through nerdctl, from code.
 *
 *   sudo npm run example:containerd
 *
 * The same thing the CLI does (`sudo npx fiber-servo up examples/app.tsx`),
 * spelled out: `serve()` binds the tree to a runtime, prints ops and status
 * changes, and Ctrl-C tears everything down.
 *
 * Kill a replica (`sudo nerdctl kill web-1`) and watch the tree bring it
 * back with backoff. Stop the database (`sudo nerdctl stop db`) and watch
 * it come back, get probed, and be marked ready again.
 */
import { containerd, formatOp, serve, type ContainerStatus } from '../src/index.js';
import App from './app.js';

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

const served = serve(<App />, {
  runtime: containerd({ namespace: process.env['FIBER_SERVO_NAMESPACE'] ?? 'default' }),
  log,
  onError: (error) => log(`!! ${error.message}`),
  onOps: (ops) => {
    for (const op of ops) log(`op ${formatOp(op)}`);
  },
});

// Print only what changed.
const seen = new Map<string, ContainerStatus>();
served.status.subscribe(() => {
  for (const [name, s] of served.status.entries()) {
    if (seen.get(name) === s) continue;
    seen.set(name, s);
    const extra = [s.exitCode !== undefined && `exit ${s.exitCode}`, s.ready && 'ready', s.reason]
      .filter(Boolean)
      .join(', ');
    log(`status ${name} ${s.state}${extra ? ` (${extra})` : ''}`);
  }
});

process.once('SIGINT', async () => {
  log('stopping');
  await served.stop();
  process.exit(0);
});
