/**
 * Phase-2 walkthrough: composition, a network, and dependency ordering.
 *
 *   npm run example:webapp
 *
 * <WebApp/> is a plain function: a network, a database, and a deployment
 * that only mounts once the database has been reported running. The dummy
 * runtime reports every CREATE as running, so the gate opens by itself.
 */
import { Container, Deployment, Network, Ready, createDummyRuntime, createRoot, createStatusStore } from '../src/index.js';

function WebApp({ replicas, image }: { replicas: number; image: string }) {
  return (
    <Network name="app">
      <Container name="db" image="postgres:16" env={{ POSTGRES_PASSWORD: 'dev' }} />
      <Ready on="db">
        <Deployment name="web" replicas={replicas}>
          <Container image={image} env={{ DATABASE_HOST: 'db' }} />
        </Deployment>
      </Ready>
    </Network>
  );
}

const status = createStatusStore();
const root = createRoot({ status, sink: createDummyRuntime({ status }) });

console.log('# mount: network and db first; web waits for db');
root.render(<WebApp replicas={2} image="nginx:1.26" />);
console.log('# (db reported running by the dummy runtime -> gate opens)');
await root.settle();

console.log('# scale to 3 and bump the image: web-0/1 UPDATE, web-2 CREATE, db untouched');
root.render(<WebApp replicas={3} image="nginx:1.27" />);
await root.settle();

console.log('# unmount: containers first, network last');
root.unmount();
