/**
 * Real runtime: containerd through `nerdctl compose`, from code.
 *
 *   sudo npm run example:containerd
 *
 * The same thing the CLI does (`sudo npx fiber-servo up examples/app.tsx`),
 * spelled out: `serve()` binds the tree to a runtime, prints what each pass
 * is about to apply and what it then observes, and Ctrl-C tears it down.
 *
 * Kill a replica (`sudo nerdctl kill fiber-servo-web-<generation>-1-1`) and
 * watch it come back — with no React render involved, because the tree still
 * says the same thing it said before.
 */
import { containerd, formatPlan, planIsEmpty, serve, type ObservedContainer } from '../src/index.js';
import App from './app.js';

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

const served = serve(<App />, {
  runtime: containerd({ namespace: process.env['FIBER_SERVO_NAMESPACE'] ?? 'default' }),
  log,
  onError: (error) => log(`!! ${error.message}`),
  onApply: (plan) => {
    if (planIsEmpty(plan)) return;
    for (const line of formatPlan(plan).split('\n')) log(line);
  },
});

// Print only what changed. Snapshots are immutable, so identity is the test.
const seen = new Map<string, ObservedContainer>();
served.observed.subscribe(() => {
  for (const [name, container] of served.observed.snapshot().containers) {
    if (seen.get(name) === container) continue;
    seen.set(name, container);
    const ready = container.ready ? '/ready' : '';
    const exit = container.exitCode === undefined ? '' : ` exit=${container.exitCode}`;
    log(`container ${name} ${container.phase}${ready}${exit}`);
  }
});

process.once('SIGINT', async () => {
  log('stopping');
  await served.stop();
  process.exit(0);
});
