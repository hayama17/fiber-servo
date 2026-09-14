/**
 * The smallest thing that works: one network, one Pod, one container.
 *
 * Run it with `npm run example`. It uses the in-memory runtime, so nothing is
 * installed and no containerd is contacted — what you see printed is exactly
 * what the control plane decided to do.
 */
import { Container, Network, Pod, formatAction, memory, serve } from '../src/index.js';

const app = (
  <>
    <Network name="demo" subnet="10.88.0.0/24" />

    <Pod name="web" network="demo" labels={{ app: 'web' }}>
      <Container name="nginx" image="docker.io/library/nginx:alpine" ports={[80]} />
    </Pod>
  </>
);

const served = serve(app, {
  runtime: memory(),
  onActions: (actions) => {
    for (const action of actions) console.log(`  ${formatAction(action)}`);
  },
});

console.log('reconciling:');
await served.root.settle();
await served.idle();

console.log('\nobserved:');
for (const pod of served.observed.snapshot().pods.values()) {
  console.log(`  ${pod.name} ${pod.phase}${pod.ip ? ` ip=${pod.ip}` : ''}`);
}

await served.stop();
