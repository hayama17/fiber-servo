/**
 * Self-healing: the status store drives restarts, still without a runtime.
 *
 *   npm run example:self-heal
 *
 * The dummy runtime reports every CREATE and START as running. We play the
 * event source and report deaths by hand.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { Container, Deployment, dummy, serve } from '../src/index.js';

console.log('# mount 2 replicas (dummy runtime reports them running)');
const served = serve(
  <Deployment name="web" replicas={2}>
    <Container image="nginx" restart={{ baseDelayMs: 100, factor: 2 }} />
  </Deployment>,
  { runtime: dummy({ log: console.log }) },
);

console.log('# web-1 dies -> START after 100ms');
served.status.set('web-1', 'dead', { exitCode: 137 });
await sleep(150);

console.log('# web-1 dies again -> backoff doubles, START after 200ms');
served.status.set('web-1', 'dead', { exitCode: 137 });
await sleep(150);
console.log('  (nothing yet)');
await sleep(100);

console.log('# stop');
await served.stop();
