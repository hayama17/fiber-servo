/**
 * Phase-0 walkthrough: no docker, just the ops the tree produces.
 *
 *   npm run example
 */
import { Container, Deployment, createDummyRuntime, createRoot } from '../src/index.js';

const root = createRoot({ sink: createDummyRuntime() });

const web = (replicas: number, image: string) => (
  <Deployment name="web" replicas={replicas}>
    <Container image={image} ports={[80]} />
  </Deployment>
);

console.log('# initial: 3 replicas');
root.render(web(3, 'nginx:1.26'));

console.log('# scale 3 -> 5');
root.render(web(5, 'nginx:1.26'));

console.log('# bump image');
root.render(web(5, 'nginx:1.27'));

console.log('# same tree again (no ops expected)');
root.render(web(5, 'nginx:1.27'));

console.log('# scale 5 -> 2');
root.render(web(2, 'nginx:1.27'));

console.log('# unmount');
root.unmount();
