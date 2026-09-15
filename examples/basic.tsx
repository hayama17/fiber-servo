// npm run example
import { Container, Network } from '../src/index.js';

export default function Basic() {
  return (
    <>
      <Network name="demo" subnet="10.88.0.0/24" />

      <Container
        name="web"
        image="docker.io/library/nginx:alpine"
        network="demo"
        labels={{ app: 'web' }}
        ports={[80]}
      />
    </>
  );
}
