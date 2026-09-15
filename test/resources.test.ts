import { describe, expect, it } from 'vitest';
import {
  digest,
  resourcesOfKind,
  selectorMatches,
  shortDigest,
  SHORT_DIGEST_LENGTH,
  specValueEquals,
  type ContainerSpec,
  type DesiredState,
} from '../src/resources.js';

// `digest` decides whether a running container is still the one that was
// asked for, whether a restart history still applies to what is being run,
// and which generation a replica belongs to. A collision is therefore not a
// cosmetic problem: it is a changed spec that reconciles as unchanged, with
// nothing anywhere to notice.

describe('digest', () => {
  const spec: ContainerSpec = {
    name: 'api',
    image: 'api:v1',
    env: { B: '2', A: '1' },
    resources: { cpu: 0.5 },
  };

  it('is 64 lowercase hex characters', () => {
    expect(digest(spec)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key order', () => {
    const reordered: ContainerSpec = {
      resources: { cpu: 0.5 },
      env: { A: '1', B: '2' },
      image: 'api:v1',
      name: 'api',
    };
    expect(digest(reordered)).toBe(digest(spec));
  });

  it('ignores a key whose value is undefined, the way an unset prop reads', () => {
    expect(digest({ ...spec, command: undefined })).toBe(digest(spec));
  });

  it.each([
    ['image', { ...spec, image: 'api:v2' }],
    ['a command', { ...spec, command: ['./server'] }],
    ['one env value', { ...spec, env: { A: '1', B: '3' } }],
    ['an added env key', { ...spec, env: { A: '1', B: '2', C: '3' } }],
    ['cpu', { ...spec, resources: { cpu: 0.6 } }],
    ['the name', { ...spec, name: 'api-2' }],
  ])('changes when %s changes', (_what, changed) => {
    expect(digest(changed)).not.toBe(digest(spec));
  });

  it('distinguishes values a looser hash could confuse', () => {
    // Shapes that stringify similarly if you are careless about it.
    expect(digest({ a: '1' })).not.toBe(digest({ a: 1 }));
    expect(digest({ a: ['b'] })).not.toBe(digest({ a: 'b' }));
    expect(digest({ a: { b: 'c' } })).not.toBe(digest({ ab: 'c' }));
    // `null` and `undefined` deliberately do hash alike: an absent key and a
    // key set to nothing are the same spec, which is what makes
    // `{ command: undefined }` equal to no command at all above.
    expect(digest(null)).toBe(digest(undefined));
  });

  it('is stable across calls, which is what makes it usable as a recorded label', () => {
    expect(digest(spec)).toBe(digest(structuredClone(spec)));
  });
});

// The short form exists for one reason — a digest inside a container name is
// read by humans — and keeping it a separate function is what stops that
// readability decision from quietly becoming an identity decision.
describe('shortDigest', () => {
  const template = { image: 'api:v1' };

  it(`is the first ${String(SHORT_DIGEST_LENGTH)} characters of the full digest, and nothing else`, () => {
    expect(shortDigest(template)).toBe(digest(template).slice(0, SHORT_DIGEST_LENGTH));
    expect(shortDigest(template)).toHaveLength(SHORT_DIGEST_LENGTH);
  });

  it('is fixed width, so a generation can be recovered from the end of a name with hyphens in it', () => {
    const name = `my-app-with-hyphens-${shortDigest(template)}`;
    expect(name.slice(-SHORT_DIGEST_LENGTH)).toBe(shortDigest(template));
  });

  it('still separates specs that differ', () => {
    expect(shortDigest({ image: 'api:v1' })).not.toBe(shortDigest({ image: 'api:v2' }));
  });

  it('is not the identity comparison: the full digest carries more', () => {
    expect(digest(template).length).toBeGreaterThan(shortDigest(template).length);
  });
});

describe('specValueEquals', () => {
  it('compares structurally, not by reference', () => {
    expect(specValueEquals({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(specValueEquals({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });

  it('does not treat an array and an object with the same keys as equal', () => {
    expect(specValueEquals(['x'], { 0: 'x' })).toBe(false);
  });

  it('notices an extra key', () => {
    expect(specValueEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe('selectorMatches', () => {
  it('matches when every entry is present and equal', () => {
    expect(selectorMatches({ app: 'api' }, { app: 'api', tier: 'backend' })).toBe(true);
  });

  it('does not match on a missing or different value', () => {
    expect(selectorMatches({ app: 'api' }, { app: 'web' })).toBe(false);
    expect(selectorMatches({ app: 'api' }, {})).toBe(false);
    expect(selectorMatches({ app: 'api' }, undefined)).toBe(false);
  });

  // An empty selector matching everything would make one typo route a
  // Service at every container on the machine.
  it('matches nothing when the selector is empty', () => {
    expect(selectorMatches({}, { app: 'api' })).toBe(false);
  });
});

describe('resourcesOfKind', () => {
  const desired: DesiredState = {
    resources: [
      { kind: 'network', name: 'backend', spec: { name: 'backend' } },
      { kind: 'container', name: 'api', spec: { name: 'api', image: 'api:v1' } },
      { kind: 'network', name: 'frontend', spec: { name: 'frontend' } },
    ],
  };

  it('returns only that kind, in tree order', () => {
    expect(resourcesOfKind(desired, 'network').map((r) => r.name)).toEqual(['backend', 'frontend']);
    expect(resourcesOfKind(desired, 'container').map((r) => r.name)).toEqual(['api']);
    expect(resourcesOfKind(desired, 'service')).toEqual([]);
  });
});
