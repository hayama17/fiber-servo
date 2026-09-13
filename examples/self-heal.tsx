/**
 * Phase-1 walkthrough: the status store drives restarts, still without docker.
 *
 *   npx tsx examples/self-heal.tsx
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { Container, Deployment, createDummyRuntime, createRoot, createStatusStore } from '../src/index.js';

const status = createStatusStore();
const root = createRoot({ status, sink: createDummyRuntime({ status }) });

console.log('# mount 2 replicas (dummy runtime reports them running)');
root.render(
  <Deployment name="web" replicas={2}>
    <Container image="nginx" restart={{ baseDelayMs: 100, factor: 2 }} />
  </Deployment>,
);

console.log('# web-1 dies -> START after 100ms');
status.set('web-1', 'dead', { exitCode: 137 });
await sleep(150);

console.log('# web-1 dies again -> backoff doubles, START after 200ms');
status.set('web-1', 'dead', { exitCode: 137 });
await sleep(150);
console.log('  (nothing yet)');
await sleep(100);

console.log('# unmount');
root.unmount();
