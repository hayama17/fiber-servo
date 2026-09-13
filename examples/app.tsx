/**
 * The whole application, declared once. The tree shape is the topology:
 * inside <Network> means membership, inside <Container> means dependency.
 *
 *   npx fiber-servo plan examples/app.tsx   # see the ops, run nothing
 *   sudo npx fiber-servo up examples/app.tsx  # run it on containerd
 */
import { Container, Deployment, Network } from '../src/index.js';

export default function App() {
  return (
    <Network name="app">
      <Container
        name="db"
        image="postgres:16"
        env={{ POSTGRES_PASSWORD: 'dev' }}
        readiness={{ exec: ['pg_isready', '-U', 'postgres'] }}
      >
        <Deployment name="web" replicas={2} service={{ port: 80, publish: 8080 }}>
          <Container image="nginx:alpine" env={{ DATABASE_HOST: 'db' }} />
        </Deployment>
      </Container>
    </Network>
  );
}
