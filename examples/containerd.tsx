/**
 * Real runtime: containerd through nerdctl.
 *
 *   sudo npx tsx examples/containerd.tsx
 *
 * Needs a running containerd and `nerdctl` on PATH. Mounts two nginx
 * replicas, then waits. Kill one (`sudo nerdctl kill web-1`) and watch the
 * tree bring it back with backoff. Ctrl-C tears everything down.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Container,
  Deployment,
  createContainerdRuntime,
  createNerdctl,
  createRoot,
  createStatusStore,
  formatOp,
  watchContainerd,
} from '../src/index.js';

const nerdctl = createNerdctl({ namespace: process.env['FIBER_SERVO_NAMESPACE'] ?? 'default' });
const status = createStatusStore();
const index = new Map<string, string>();
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

const runtime = createContainerdRuntime({
  nerdctl,
  status,
  index,
  log,
  onError: (error, op) => log(`!! ${formatOp(op)}: ${error.message}`),
});
const root = createRoot({
  status,
  sink: (ops) => {
    for (const op of ops) log(`op ${formatOp(op)}`);
    runtime.sink(ops);
  },
});

const stop = new AbortController();
const watching = watchContainerd({ nerdctl, status, index, signal: stop.signal, log });
status.subscribe(() => {
  for (const [name, s] of status.entries())
    log(`status ${name} ${s.state}${s.exitCode !== undefined ? ` (exit ${s.exitCode})` : ''}`);
});

root.render(
  <Deployment name="web" replicas={2}>
    <Container image="docker.io/library/nginx:alpine" restart={{ baseDelayMs: 1000, maxDelayMs: 30_000 }} />
  </Deployment>,
);

process.once('SIGINT', async () => {
  log('unmounting');
  root.unmount();
  await runtime.idle();
  stop.abort();
  await watching;
  process.exit(0);
});

for (;;) await sleep(60_000);
