/**
 * A small application: a database, a rolled-out API, and one Service in front
 * of the replicas.
 *
 * Three things worth noticing:
 *
 *   - the API is a <Deployment>, so editing the image rolls the replicas over
 *     rather than editing them in place;
 *   - <Service> has a `selector`, not a list of targets — it finds its
 *     backends in observed state, which is what lets replicas come and go;
 *   - <Ready on="db"> holds the migration back until the database answers its
 *     readiness probe.
 *
 * Run it with `npm run example:webapp`.
 */
import {
  Container,
  Deployment,
  Network,
  Ready,
  Service,
  formatPlan,
  planIsEmpty,
  memory,
  serve,
} from '../src/index.js';

const app = (
  <>
    <Network name="backend" />

    <Container
      name="db"
      image="docker.io/library/postgres:16"
      network="backend"
      labels={{ app: 'db' }}
      env={{ POSTGRES_PASSWORD: 'dev' }}
      ports={[5432]}
      readiness={{ exec: ['pg_isready', '-U', 'postgres'] }}
    />

    {/* Declared only once the database reports ready. */}
    <Ready on="db" until="ready">
      <Container name="migrate" image="api:v2" network="backend" command={['./migrate']} />

      <Deployment name="api" replicas={3} strategy={{ maxSurge: 1 }}>
        <Container
          image="api:v2"
          network="backend"
          labels={{ app: 'api' }}
          env={{ DATABASE_URL: 'postgres://postgres:dev@db:5432/postgres' }}
          ports={[8080]}
        />
      </Deployment>

      <Service
        name="api"
        network="backend"
        selector={{ app: 'api' }}
        port={80}
        targetPort={8080}
        publish={8080}
      />
    </Ready>
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
for (let i = 0; i < 20; i++) {
  await served.root.settle();
  await served.idle();
}

console.log('\nobserved:');
for (const container of served.observed.snapshot().containers.values()) {
  console.log(`  ${container.name} ${container.phase}`);
}

await served.stop();
