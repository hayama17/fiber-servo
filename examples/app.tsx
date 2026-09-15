// npm run example:plan; npm run example:containerd to run on containerd.
import { Container, Deployment, Network, Ready, Service } from '../src/index.js';

export default function App() {
  return (
    <>
      <Network name="app" />

      <Container
        name="db"
        image="docker.io/library/postgres:16"
        network="app"
        labels={{ app: 'db' }}
        env={{ POSTGRES_PASSWORD: 'dev' }}
        ports={[5432]}
        readiness={{ exec: ['pg_isready', '-U', 'postgres'] }}
      />

      <Ready on="db" until="ready">
        <Deployment name="web" replicas={2}>
          <Container
            image="docker.io/library/nginx:alpine"
            network="app"
            labels={{ app: 'web' }}
            env={{ DATABASE_HOST: 'db' }}
            ports={[80]}
          />
        </Deployment>

        <Service name="web" network="app" selector={{ app: 'web' }} port={80} publish={8080} />
      </Ready>
    </>
  );
}
