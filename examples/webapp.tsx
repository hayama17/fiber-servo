// npm run example:webapp (memory runtime; api:v2 is a placeholder image)
import { Container, Deployment, Network, Ready, Service } from '../src/index.js';

export default function WebApp() {
  return (
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
}
