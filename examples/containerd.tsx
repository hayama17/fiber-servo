/**
 * Real runtime: containerd through nerdctl, from code.
 *
 *   sudo npm run example:containerd
 *
 * The same thing the CLI does (`sudo npx fiber-servo up examples/app.tsx`),
 * spelled out: `serve()` binds the tree to a runtime, prints the actions the
 * control plane takes and the state it observes, and Ctrl-C tears it down.
 *
 * Kill a replica (`sudo nerdctl kill web-<generation>-1`) and watch the
 * ReplicaSet controller replace it — with no React render involved, because
 * the tree still says the same thing it said before.
 */
import { containerd, formatAction, serve, type ObservedPod } from '../src/index.js';
import App from './app.js';

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

const served = serve(<App />, {
  runtime: containerd({ namespace: process.env['FIBER_SERVO_NAMESPACE'] ?? 'default' }),
  log,
  onError: (error) => log(`!! ${error.message}`),
  onActions: (actions) => {
    for (const action of actions) log(formatAction(action));
  },
});

// Print only what changed.
const seen = new Map<string, ObservedPod>();
served.observed.subscribe(() => {
  for (const [name, pod] of served.observed.snapshot().pods) {
    if (seen.get(name) === pod) continue;
    seen.set(name, pod);
    const detail = pod.containers.map((c) => `${c.name}=${c.phase}${c.ready ? '/ready' : ''}`).join(' ');
    log(`pod ${name} ${pod.phase}${pod.ip ? ` ip=${pod.ip}` : ''}${detail ? ` [${detail}]` : ''}`);
  }
});

process.once('SIGINT', async () => {
  log('stopping');
  await served.stop();
  process.exit(0);
});
