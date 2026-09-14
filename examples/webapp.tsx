/**
 * A small application: a database Pod, a rolled-out API, and one Service in
 * front of the replicas.
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
  Pod,
  Ready,
  Service,
  formatAction,
  memory,
  serve,
} from '../src/index.js';

const app = (
  <>
    <Network name="backend" />

    <Pod name="db" network="backend" labels={{ app: 'db' }}>
      <Container
        name="postgres"
        image="docker.io/library/postgres:16"
        env={{ POSTGRES_PASSWORD: 'dev' }}
        ports={[5432]}
        readiness={{ exec: ['pg_isready', '-U', 'postgres'] }}
      />
    </Pod>

    {/* Declared only once the database reports ready. */}
    <Ready on="db" until="ready">
      <Pod name="migrate" network="backend">
        <Container name="migrate" image="api:v2" command={['./migrate']} />
      </Pod>

      <Deployment name="api" replicas={3} strategy={{ maxSurge: 1 }}>
        <Pod network="backend" labels={{ app: 'api' }}>
          <Container
            name="app"
            image="api:v2"
            env={{ DATABASE_URL: 'postgres://postgres:dev@db:5432/postgres' }}
            ports={[8080]}
          />
        </Pod>
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
  onActions: (actions) => {
    for (const action of actions) console.log(`  ${formatAction(action)}`);
  },
});

console.log('reconciling:');
for (let i = 0; i < 20; i++) {
  await served.root.settle();
  await served.idle();
}

console.log('\nobserved:');
for (const pod of served.observed.snapshot().pods.values()) {
  console.log(`  ${pod.name} ${pod.phase}`);
}

await served.stop();
