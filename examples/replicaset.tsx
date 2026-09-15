/**
 * The point of the whole project, in one file.
 *
 * A ReplicaSet asks for three containers. We kill one behind the control
 * plane's back. It comes back — and the counter below shows that React did
 * not render even once to make that happen.
 *
 * That is the split the architecture exists to make: the JSX says "three",
 * which is still true after a container dies, so there is nothing for React
 * to re-render. What changed was *observed state*, and reacting to that is a
 * controller's job.
 *
 * Run it with `npm run example:replicaset`.
 */
import { Container, ReplicaSet, createMemoryRuntime, formatPlan, planIsEmpty, serve } from '../src/index.js';

const runtime = createMemoryRuntime();

let reactCommits = 0;

const served = serve(
  <ReplicaSet name="api" replicas={3}>
    <Container image="api:v1" labels={{ app: 'api' }} ports={[8080]} />
  </ReplicaSet>,
  {
    runtime: () => runtime,
    // Backoff is normally seconds; shorten it so the example finishes quickly.
    restart: { baseDelayMs: 5 },
    onDesired: () => {
      reactCommits += 1;
    },
    onApply: (plan) => {
      if (planIsEmpty(plan)) return;
      for (const line of formatPlan(plan).split('\n')) console.log(`  ${line}`);
    },
  },
);

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await served.root.settle();
    await served.idle();
    await new Promise((r) => setTimeout(r, 10));
  }
};

const containers = (): string =>
  [...served.observed.snapshot().containers.values()].map((c) => `${c.name}:${c.phase}`).join(' ');

console.log('bringing up three replicas:');
await settle();
console.log(`  -> ${containers()}`);
console.log(`  React commits so far: ${reactCommits}`);

console.log('\nkilling api-1 behind the control plane’s back:');
const commitsBeforeFailure = reactCommits;
runtime.kill('api-1', { exitCode: 137 });
await settle();
console.log(`  -> ${containers()}`);
console.log(
  `  React commits caused by the failure: ${reactCommits - commitsBeforeFailure} (the tree never changed)`,
);

await served.stop();
