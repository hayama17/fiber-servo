/**
 * The point of the whole project, in one file.
 *
 * A ReplicaSet asks for three Pods. We kill one behind the control plane's
 * back. The Pod comes back — and the counter below shows that React did not
 * render even once to make that happen.
 *
 * That is the split the architecture exists to make: the JSX says "three",
 * which is still true after a Pod dies, so there is nothing for React to
 * re-render. What changed was *observed state*, and reacting to that is a
 * controller's job.
 *
 * Run it with `npm run example:replicaset`.
 */
import { Container, Pod, ReplicaSet, createMemoryRuntime, formatAction, serve } from '../src/index.js';

const runtime = createMemoryRuntime();

let reactCommits = 0;

const served = serve(
  <ReplicaSet name="api" replicas={3}>
    <Pod labels={{ app: 'api' }}>
      <Container name="app" image="api:v1" ports={[8080]} />
    </Pod>
  </ReplicaSet>,
  {
    runtime: () => runtime,
    // Backoff is normally seconds; shorten it so the example finishes quickly.
    restart: { baseDelayMs: 5 },
    onDesired: () => {
      reactCommits += 1;
    },
    onActions: (actions) => {
      for (const action of actions) console.log(`  ${formatAction(action)}`);
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

const pods = (): string =>
  [...served.observed.snapshot().pods.values()].map((p) => `${p.name}:${p.phase}`).join(' ');

console.log('bringing up three replicas:');
await settle();
console.log(`  -> ${pods()}`);
console.log(`  React commits so far: ${reactCommits}`);

console.log('\nkilling api-1 behind the control plane’s back:');
const commitsBeforeFailure = reactCommits;
runtime.kill('api-1', { exitCode: 137, reason: 'killed' });
await settle();
console.log(`  -> ${pods()}`);
console.log(
  `  React commits caused by the failure: ${reactCommits - commitsBeforeFailure} (the tree never changed)`,
);

await served.stop();
