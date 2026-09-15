import { describe, expect, it } from 'vitest';
import {
  changedServices,
  decodeReadiness,
  encodeReadiness,
  MANAGED_LABEL,
  orphanedServices,
  READINESS_LABEL,
  renderCompose,
  SPEC_LABEL,
  toComposeApplication,
  toComposeService,
} from '../src/compose.js';
import type { ContainerSpec } from '../src/resources.js';

const container = (spec: Partial<ContainerSpec> & { name: string }): ContainerSpec => ({
  image: 'app:1',
  ...spec,
});

describe('toComposeService', () => {
  it('maps only the fields that were set', () => {
    const service = toComposeService(container({ name: 'api' }));
    expect(service.image).toBe('app:1');
    expect(service.command).toBeUndefined();
    expect(service.environment).toBeUndefined();
    expect(service.networks).toBeUndefined();
    expect(service.ports).toBeUndefined();
    expect(service.deploy).toBeUndefined();
  });

  it('keeps the user labels and adds its own', () => {
    const service = toComposeService(container({ name: 'api', labels: { app: 'api' } }));
    expect(service.labels?.app).toBe('api');
    expect(service.labels?.[MANAGED_LABEL]).toBe('true');
    expect(service.labels?.[SPEC_LABEL]).toMatch(/^[0-9a-f]{8}$/);
  });

  it('publishes ports in Compose short syntax, with the protocol only when it is not tcp', () => {
    const service = toComposeService(
      container({
        name: 'api',
        publish: [
          { host: 8080, target: 80 },
          { host: 5353, target: 53, protocol: 'udp' },
        ],
      }),
    );
    expect(service.ports).toEqual(['8080:80', '5353:53/udp']);
  });

  it('maps resource limits onto deploy.resources.limits', () => {
    const service = toComposeService(container({ name: 'api', resources: { cpu: 0.5, memory: '512m' } }));
    expect(service.deploy).toEqual({ resources: { limits: { cpus: '0.5', memory: '512m' } } });
  });

  it('leaves deploy off when resources is present but empty', () => {
    expect(toComposeService(container({ name: 'api', resources: {} })).deploy).toBeUndefined();
  });

  // The digest is computed from the ContainerSpec, not from the rendered
  // service, so it does not move when this mapping changes shape. A reader
  // comparing a label against a desired spec compares like with like.
  it('gives the same digest to equal specs and different digests to different ones', () => {
    const a = toComposeService(container({ name: 'api', env: { A: '1' } }));
    const b = toComposeService(container({ name: 'api', env: { A: '1' } }));
    const c = toComposeService(container({ name: 'api', env: { A: '2' } }));
    expect(a.labels?.[SPEC_LABEL]).toBe(b.labels?.[SPEC_LABEL]);
    expect(a.labels?.[SPEC_LABEL]).not.toBe(c.labels?.[SPEC_LABEL]);
  });
});

// nerdctl does not implement Compose's `healthcheck`, and `apply()` is handed
// a ComposeApplication and nothing else -- so a probe that does not ride in a
// label cannot reach the adapter at all, and `<Ready until="ready">` would
// wait for ever.
describe('the readiness label', () => {
  it('is set exactly when the spec carries a probe', () => {
    expect(toComposeService(container({ name: 'api' })).labels?.[READINESS_LABEL]).toBeUndefined();
    const probed = toComposeService(container({ name: 'api', readiness: { exec: ['true'] } }));
    expect(probed.labels?.[READINESS_LABEL]).toBeDefined();
  });

  it('round-trips a probe through a label value', () => {
    const probe = { exec: ['sh', '-c', 'curl -sf http://localhost:8080/health'], intervalMs: 500 };
    expect(decodeReadiness(encodeReadiness(probe))).toEqual(probe);
  });

  it('encodes to something a label can hold: no commas, quotes or spaces', () => {
    const encoded = encodeReadiness({ exec: ['sh', '-c', 'test -f /ready'] });
    expect(encoded).not.toMatch(/[,"' ]/);
  });

  it('reads a foreign or corrupt value as "no probe" rather than throwing', () => {
    expect(decodeReadiness(undefined)).toBeUndefined();
    expect(decodeReadiness('')).toBeUndefined();
    expect(decodeReadiness('not json at all')).toBeUndefined();
    expect(decodeReadiness('%ZZ')).toBeUndefined();
    expect(decodeReadiness(encodeURIComponent('{"exec":"not an array"}'))).toBeUndefined();
  });
});

describe('toComposeApplication', () => {
  it('keys services by the name the controllers chose', () => {
    const app = toComposeApplication([container({ name: 'api-0' }), container({ name: 'api-1' })], []);
    expect(Object.keys(app.services)).toEqual(['api-0', 'api-1']);
  });

  it('refuses two containers with the same name rather than silently dropping one', () => {
    expect(() => toComposeApplication([container({ name: 'api' }), container({ name: 'api' })], [])).toThrow(
      /both named "api"/,
    );
  });

  // Without an explicit `name`, Compose prefixes the runtime name with the
  // project (`backend` becomes `fiber-servo_backend`) and the name written
  // into the model stops equalling the name observed back on the container.
  it('pins every network name so it survives the round trip unprefixed', () => {
    const app = toComposeApplication([], [{ name: 'backend' }], 'proj');
    expect(app.networks).toEqual({ backend: { name: 'backend' } });
  });

  // Verified against nerdctl 2.1.2: the created network really does get this
  // CIDR, with a gateway assigned from it. Before this, `subnet` was a field
  // you could set that did nothing at all.
  it('materialises a declared subnet into the Compose network', () => {
    const app = toComposeApplication([], [{ name: 'backend', subnet: '10.4.0.0/24' }], 'proj');
    expect(app.networks['backend']).toEqual({
      name: 'backend',
      ipam: { config: [{ subnet: '10.4.0.0/24' }] },
    });
  });

  it('declares a network a container joins but the tree never declared', () => {
    const app = toComposeApplication([container({ name: 'api', network: 'backend' })], []);
    expect(app.networks.backend).toEqual({ name: 'backend' });
    expect(app.services['api']?.networks).toEqual(['backend']);
  });

  it('uses the project it is given', () => {
    expect(toComposeApplication([], [], 'staging').name).toBe('staging');
  });
});

describe('renderCompose', () => {
  it('emits JSON, which is valid YAML and needs none of YAML’s quoting rules', () => {
    const app = toComposeApplication([container({ name: 'api', env: { FLAG: 'yes', VERSION: '1.0' } })], []);
    const parsed = JSON.parse(renderCompose(app));
    // `yes` and `1.0` are the two classic YAML traps: a plain scalar would
    // parse as a boolean and a float. Through JSON they stay strings.
    expect(parsed.services.api.environment).toEqual({ FLAG: 'yes', VERSION: '1.0' });
  });

  it('is stable: the same model renders the same bytes', () => {
    const app = toComposeApplication([container({ name: 'api' })], [{ name: 'backend' }]);
    expect(renderCompose(app)).toBe(renderCompose(app));
  });
});

describe('changedServices / orphanedServices', () => {
  const app = toComposeApplication([container({ name: 'api' }), container({ name: 'web' })], []);
  const digestOf = (name: string) => app.services[name]?.labels?.[SPEC_LABEL] as string;

  it('does not call a service that does not exist yet "changed" -- `up` will create it', () => {
    expect(changedServices(app, new Map())).toEqual([]);
  });

  it('reports only the service whose recorded spec differs', () => {
    const recorded = new Map([
      ['api', digestOf('api')],
      ['web', 'deadbeef'],
    ]);
    expect(changedServices(app, recorded)).toEqual(['web']);
  });

  it('reports what the model no longer declares', () => {
    const recorded = new Map([
      ['api', digestOf('api')],
      ['gone', 'deadbeef'],
    ]);
    expect(orphanedServices(app, recorded)).toEqual(['gone']);
    expect(changedServices(app, recorded)).toEqual([]);
  });

  it('sorts both lists, so a plan reads the same way twice', () => {
    const stale = new Map([
      ['web', 'x'],
      ['api', 'x'],
    ]);
    expect(changedServices(app, stale)).toEqual(['api', 'web']);
    const orphans = new Map([
      ['z-old', 'x'],
      ['a-old', 'x'],
    ]);
    expect(orphanedServices(app, orphans)).toEqual(['a-old', 'z-old']);
  });
});
