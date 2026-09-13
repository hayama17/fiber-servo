/**
 * Composition, a network, dependency ordering and a service, without a
 * runtime.
 *
 *   npm run example:webapp
 *
 * The tree shape is the topology: inside <Network> is membership, inside
 * <Container> is dependency. The deployment only mounts once the database
 * is ready, and its replicas sit behind one proxy. The dummy runtime reports
 * every CREATE as running and ready, so the gate opens by itself.
 */
import { Container, Deployment, Network, dummy, serve } from '../src/index.js';

function WebApp({ replicas, image }: { replicas: number; image: string }) {
  return (
    <Network name="app">
      <Container
        name="db"
        image="postgres:16"
        env={{ POSTGRES_PASSWORD: 'dev' }}
        readiness={{ exec: ['pg_isready', '-U', 'postgres'] }}
      >
        <Deployment name="web" replicas={replicas} service={{ port: 80, publish: 8080 }}>
          <Container image={image} env={{ DATABASE_HOST: 'db' }} />
        </Deployment>
      </Container>
    </Network>
  );
}

console.log('# mount: network and db first; web waits for db to be ready');
console.log(
  '# (the dummy runtime reports db ready at once, so web-* and the proxy follow in the next commit)',
);
const served = serve(<WebApp replicas={2} image="nginx:1.26" />, { runtime: dummy({ log: console.log }) });
await served.root.settle();

console.log('# scale to 3 and bump the image: web-0/1 UPDATE, web-2 CREATE, proxy UPDATE, db untouched');
served.root.render(<WebApp replicas={3} image="nginx:1.27" />);
await served.root.settle();

console.log('# stop: dependents first, then db, then the network');
await served.stop();
