/**
 * The whole application, declared once — and the file the CLI examples use.
 *
 *   npx fiber-servo plan examples/app.tsx      # print the actions, run nothing
 *   sudo npx fiber-servo up examples/app.tsx   # run it on containerd
 *
 * Read the shape: nesting is ownership (a Deployment owns a Pod template, a
 * Pod owns its containers) and props are references (a Pod joins a Network by
 * name, a Service selects Pods by label).
 */
import { Container, Deployment, Network, Pod, Ready, Service } from '../src/index.js';

export default function App() {
  return (
    <>
      <Network name="app" />

      <Pod name="db" network="app" labels={{ app: 'db' }}>
        <Container
          name="postgres"
          image="docker.io/library/postgres:16"
          env={{ POSTGRES_PASSWORD: 'dev' }}
          ports={[5432]}
          readiness={{ exec: ['pg_isready', '-U', 'postgres'] }}
        />
      </Pod>

      <Ready on="db" until="ready">
        <Deployment name="web" replicas={2}>
          <Pod network="app" labels={{ app: 'web' }}>
            <Container
              name="nginx"
              image="docker.io/library/nginx:alpine"
              env={{ DATABASE_HOST: 'db' }}
              ports={[80]}
            />
          </Pod>
        </Deployment>

        <Service name="web" network="app" selector={{ app: 'web' }} port={80} publish={8080} />
      </Ready>
    </>
  );
}
