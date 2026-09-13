/**
 * `npm run spike:grpc` - the same flow the tests assert, printed.
 *
 * Starts the fake containerd, drives it with the client that would ship, and
 * narrates every RPC so the sequence is readable without opening the tests.
 * No containerd, no root, no images.
 */
import { interpretEvent, type StatusEvent } from '../../../src/index.js';
import { connect } from './client.js';
import { createGrpcDriver } from './driver.js';
import { envelopeToEventRow, type Envelope } from './events.js';
import { startFakeContainerd } from './fake-containerd.js';

const IMAGE = 'docker.io/library/nginx:1.27';
const CHAIN_ID = 'sha256:6a1f1e1d0c0b0a09080706050403020100ffeeddccbbaa99887766554433221100';

async function main(): Promise<void> {
  const fake = await startFakeContainerd();
  fake.putImage(IMAGE, CHAIN_ID);
  console.log(`fake containerd listening on unix://${fake.address}`);

  const driver = createGrpcDriver({ address: fake.address, namespace: 'default' });
  const stop = new AbortController();

  // Two readers of the same stream: the driver's own (already translated into
  // store events) and a raw one, to show the envelope the existing nerdctl
  // watcher's `interpretEvent` is handed.
  const events: StatusEvent[] = [];
  const driverPump = (async () => {
    for await (const event of driver.events(stop.signal)) {
      events.push(event);
      console.log(`  event  ${event.kind} ${event.name}${'state' in event ? ` ${event.state}` : ''}`);
    }
  })();

  const connection = connect({ address: fake.address, namespace: 'default' });
  const rawPump = (async () => {
    for await (const envelope of connection.stream<Envelope>(
      'containerd.services.events.v1.Events',
      'Subscribe',
      { filters: ['namespace==default'] },
      stop.signal,
    )) {
      const row = envelopeToEventRow(envelope);
      if (!row) continue;
      const translated = interpretEvent(row, (id) => (id === 'web' ? 'web' : undefined));
      console.log(`  raw    ${row.Topic} -> ${translated ? JSON.stringify(translated) : 'ignored'}`);
    }
  })();

  await sleep(100); // let both subscriptions land before anything happens

  console.log('create web');
  await driver.create(
    { name: 'web', image: IMAGE, command: ['nginx', '-g', 'daemon off;'] },
    {
      'fiber-servo.managed': 'true',
      'fiber-servo.spec': 'deadbeef',
    },
  );
  console.log('start web');
  await driver.start('web');
  await sleep(100);

  console.log('list (label filter, server-side)');
  console.log(`  ${JSON.stringify(await driver.list())}`);

  console.log('probe web');
  console.log(`  exit ${(await driver.exec('web', ['true'])).code}`);

  console.log('the container dies');
  fake.exitTask('web', 137);
  await sleep(100);

  console.log('remove web');
  await driver.remove('web');
  await sleep(100);

  stop.abort();
  await Promise.all([driverPump, rawPump]);
  connection.close();
  await driver.close();
  await fake.stop();

  console.log(`\nRPCs in order:\n  ${fake.calls.map(shorten).join('\n  ')}`);
  console.log(`\nstore events: ${JSON.stringify(events)}`);
}

function shorten(call: string): string {
  return call.replace(/^containerd\.services\.[a-z]+\.v1\./, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
