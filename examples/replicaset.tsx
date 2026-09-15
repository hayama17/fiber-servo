// npm run example:replicaset (memory runtime; api:v1 is a placeholder image)
import { Container, ReplicaSet } from '../src/index.js';

export default function Replicas() {
  return (
    <ReplicaSet name="api" replicas={3}>
      <Container image="api:v1" labels={{ app: 'api' }} ports={[8080]} />
    </ReplicaSet>
  );
}
