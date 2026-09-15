import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expandDeployment, expandReplicaSet, GENERATION_LABEL, OWNER_LABEL } from '../src/controllers.js';
import {
  createGenerationStore,
  createMemoryGenerationStore,
  defaultGenerationsPath,
} from '../src/generations.js';
import { digest, shortDigest, type ContainerTemplate, type DeploymentSpec } from '../src/resources.js';
import type { ObservedContainer, ObservedState } from '../src/runtime/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fiber-servo-generations-'));
  dirs.push(dir);
  return join(dir, 'nested', 'generations.json');
}

/** A template big enough that carrying it in a label would have been refused by containerd. */
const huge: ContainerTemplate = {
  image: 'api:v1',
  command: ['./server'],
  env: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`VAR_${String(i)}`, 'x'.repeat(64)])),
  network: 'backend',
  resources: { cpu: 0.5, memory: '512m' },
  readiness: { exec: ['/health'] },
  labels: { app: 'api' },
};

describe('createGenerationStore', () => {
  it('remembers a template under its own generation id', () => {
    const store = createGenerationStore({ path: tempPath() });
    store.remember(huge);
    expect(store.all().get(digest(huge))).toEqual(huge);
  });

  // The whole reason this is a file and not a label: it has to survive the
  // process, or a rollout interrupted by a restart cannot be finished.
  it('survives a restart: a second store over the same path has the same history', () => {
    const path = tempPath();
    createGenerationStore({ path }).remember(huge);

    const reopened = createGenerationStore({ path });
    expect(reopened.all().get(digest(huge))).toEqual(huge);
  });

  it('creates the directory it needs, and writes a file a human can read', () => {
    const path = tempPath();
    createGenerationStore({ path }).remember({ image: 'api:v1' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      [digest({ image: 'api:v1' })]: { image: 'api:v1' },
    });
  });

  it('drops what prune does not keep, and keeps what it does', () => {
    const path = tempPath();
    const store = createGenerationStore({ path });
    store.remember({ image: 'api:v1' });
    store.remember({ image: 'api:v2' });

    store.prune([digest({ image: 'api:v2' })]);

    expect([...store.all().keys()]).toEqual([digest({ image: 'api:v2' })]);
    expect([...createGenerationStore({ path }).all().keys()]).toEqual([digest({ image: 'api:v2' })]);
  });

  // Every failure here is survivable, and none of them may stop the control
  // loop: losing this file costs a rollout its gradualness, not its
  // correctness, so it must never cost the application its availability.
  it('starts empty on a corrupt file rather than throwing', () => {
    const path = tempPath();
    createGenerationStore({ path }).remember({ image: 'api:v1' });
    writeFileSync(path, '{ this is not json');

    const lines: string[] = [];
    const store = createGenerationStore({ path, log: (l) => lines.push(l) });

    expect([...store.all().keys()]).toEqual([]);
    expect(lines.join('\n')).toMatch(/unreadable generation store/);
  });

  it('ignores an entry filed under an id that is not its own digest', () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ deadbeefdeadbeef: { image: 'api:v1' } }));

    const lines: string[] = [];
    const store = createGenerationStore({ path, log: (l) => lines.push(l) });

    expect([...store.all().keys()]).toEqual([]);
    expect(lines.join('\n')).toMatch(/not the template it is filed under/);
  });

  it('starts empty when there is no file at all, without complaining', () => {
    const lines: string[] = [];
    const store = createGenerationStore({ path: tempPath(), log: (l) => lines.push(l) });
    expect([...store.all().keys()]).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe('createMemoryGenerationStore', () => {
  it('behaves the same, minus the file', () => {
    const store = createMemoryGenerationStore();
    store.remember(huge);
    expect(store.all().get(digest(huge))).toEqual(huge);
    store.prune([]);
    expect([...store.all().keys()]).toEqual([]);
  });
});

describe('defaultGenerationsPath', () => {
  it('is per project, so two projects on one machine do not share a history', () => {
    expect(defaultGenerationsPath('a')).not.toBe(defaultGenerationsPath('b'));
    expect(defaultGenerationsPath('a')).toMatch(/fiber-servo[/\\]a\.generations\.json$/);
  });
});

// The point of the whole file, end to end: a rollout that outlives the
// process that started it.
describe('recovering a rollout across a restart', () => {
  const v1: ContainerTemplate = huge;
  const v2: ContainerTemplate = { ...huge, image: 'api:v2' };
  const spec: DeploymentSpec = { name: 'web', replicas: 2, template: v2 };

  /** What a runtime would report back for the containers generation `v1` produced. */
  function running(): ObservedContainer[] {
    const generation = digest(v1);
    const name = shortDigest(v1);
    return expandReplicaSet({ name: `web-${name}`, replicas: 2, template: v1 }, EMPTY).map((c, i) => ({
      name: c.name,
      phase: 'running' as const,
      networks: ['backend'],
      image: c.image,
      labels: { ...c.labels, [OWNER_LABEL]: 'web', [GENERATION_LABEL]: generation },
      specDigest: digest({
        ...c,
        labels: { ...c.labels, [OWNER_LABEL]: 'web', [GENERATION_LABEL]: generation },
      }),
      at: i + 1,
    }));
  }

  const EMPTY: ObservedState = { containers: new Map(), revision: 0 };
  const observedOf = (containers: ObservedContainer[]): ObservedState => ({
    containers: new Map(containers.map((c) => [c.name, c])),
    revision: 1,
  });

  it('recovers the old generation exactly after the process that recorded it is gone', () => {
    const path = tempPath();
    // Process one: v1 is the current template, and gets recorded.
    createGenerationStore({ path }).remember(v1);

    // Process two: the file has been edited to v2 in the meantime, so v1 is
    // now an old generation and nothing in this process ever saw it.
    const reopened = createGenerationStore({ path });
    reopened.remember(v2);
    const old = expandDeployment(spec, observedOf(running()), reopened.all()).find(
      (rs) => rs.name === `web-${shortDigest(v1)}`,
    );

    expect(old?.template).toEqual(v1);
  });

  it('brings back a container that died mid-rollout with the identical spec', () => {
    const path = tempPath();
    createGenerationStore({ path }).remember(v1);
    const reopened = createGenerationStore({ path });
    reopened.remember(v2);

    const alive = running();
    const [killed] = alive;
    const observed = observedOf(alive.slice(1));

    const regenerated = expandDeployment(spec, observed, reopened.all())
      .flatMap((rs) =>
        expandReplicaSet(rs, observed).map((c) => ({
          ...c,
          labels: {
            ...c.labels,
            [OWNER_LABEL]: 'web',
            [GENERATION_LABEL]: digest(rs.template),
          },
        })),
      )
      .find((c) => c.name === killed!.name);

    expect(regenerated).toBeDefined();
    expect(digest(regenerated)).toBe(killed!.specDigest);
  });

  it('does not invent a spec when the history was lost', () => {
    const observed = observedOf(running());
    const empty = createGenerationStore({ path: tempPath() });
    empty.remember(v2); // only the current template is known

    const names = expandDeployment(spec, observed, empty.all()).map((rs) => rs.name);
    expect(names).toEqual([`web-${shortDigest(v2)}`]);
  });
});
