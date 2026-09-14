/**
 * The smallest thing that works: one network, one container.
 *
 * Run it with `npm run example`. It uses the in-memory runtime, so nothing is
 * installed and no containerd is contacted — what you see printed is exactly
 * what the control plane decided to do.
 */
import { Container, Network, formatPlan, planIsEmpty, memory, serve } from '../src/index.js';

const app = (
  <>
    <Network name="demo" subnet="10.88.0.0/24" />

    <Container
      name="web"
      image="docker.io/library/nginx:alpine"
      network="demo"
      labels={{ app: 'web' }}
      ports={[80]}
    />
  </>
);

const served = serve(app, {
  runtime: memory(),
  onApply: (plan) => {
    if (planIsEmpty(plan)) return;
    for (const line of formatPlan(plan).split('\n')) console.log(`  ${line}`);
  },
});

console.log('reconciling:');
await served.root.settle();
await served.idle();

console.log('\nobserved:');
for (const container of served.observed.snapshot().containers.values()) {
  console.log(`  ${container.name} ${container.phase}`);
}

await served.stop();
