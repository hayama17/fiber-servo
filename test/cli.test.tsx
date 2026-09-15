/**
 * The CLI mechanics that did not change shape with the architecture:
 * argument parsing, `plan` printing the full expansion without touching a
 * runtime, and `--watch` reconciling only the difference on save. Session
 * ownership and explicit `apply` live in test/apply.test.tsx.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCli, cli, projectRoot } from './cli-helper.js';
import { parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
  it('separates command, file and flags', () => {
    expect(parseArgs(['up', 'app.tsx', '--namespace', 'dev', '--quiet', '--address=/run/c.sock'])).toEqual({
      command: 'up',
      file: 'app.tsx',
      flags: { namespace: 'dev', quiet: true, address: '/run/c.sock' },
    });
  });
});

describe('cli plan', () => {
  beforeAll(buildCli);

  /**
   * `plan` must print the FULL expansion, including a subtree behind
   * `<Ready>` — which is not declared until its dependency container is
   * *observed* running. The old `plan` only settled React, so those
   * subtrees never appeared; the rewritten one settles React and the
   * control loop together against the in-memory runtime until neither
   * produces anything new.
   *
   * The app is written to a temp file importing "fiber-servo" by name rather
   * than pointing at `examples/app.tsx`, which imports `../src` — see the
   * `shared-fiber-servo` plugin in load.ts for why mixing a `dist/` CLI with a
   * `src/` import is refused outright. `npm run example:plan` covers the
   * examples through tsx, where both sides are the same build.
   */
  it('prints the full expansion, including subtrees gated behind <Ready>, and executes nothing', async () => {
    const dir = `${projectRoot}test/tmp-plan`;
    const file = `${dir}/app.tsx`;
    await mkdir(dir, { recursive: true });
    await writeFile(
      file,
      `
      import { Container, Deployment, Network, Ready, Service } from 'fiber-servo';
      export default () => (
        <>
          <Network name="app" />
          <Container name="db" image="postgres:16" network="app" labels={{ app: 'db' }}
                     readiness={{ exec: ['pg_isready'] }} />
          <Ready on="db" until="ready">
            <Deployment name="web" replicas={2}>
              <Container network="app" labels={{ app: 'web' }} image="nginx:alpine" ports={[80]} />
            </Deployment>
            <Service name="web" network="app" selector={{ app: 'web' }} port={80} publish={8080} />
          </Ready>
        </>
      );
    `,
    );
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['dist/cli.js', 'plan', file], {
        cwd: projectRoot,
        timeout: 60_000,
      });
      const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      expect(lines[0]).toBe('create db image=postgres:16');
      // Everything from here on is behind the gate. If `plan` regressed to
      // settling React only, the output would stop at the line above.
      const gated = lines.slice(1);
      // The Deployment's replicas are named `web-<template digest>-<index>`:
      // content-addressed, so the digest cannot be hardcoded, only shown to be
      // one generation across both replicas.
      const replicas = gated
        .map((l) => /^create web-([0-9a-f]{16})-([01]) image=nginx:alpine$/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null);
      expect(replicas, `expected two replica containers in:\n${gated.join('\n')}`).toHaveLength(2);
      expect(replicas[1]![1]).toBe(replicas[0]![1]);
      expect([replicas[0]![2], replicas[1]![2]].sort()).toEqual(['0', '1']);
      // The Service's data plane: a proxy container taking the Service's own name.
      expect(gated).toContain('create web image=docker.io/library/caddy:2-alpine');
      // "executes nothing" — every line is a plan, never a status report.
      expect(stdout).not.toContain('container db running');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('cli --watch', () => {
  beforeAll(buildCli);

  it('re-evaluates the file on save and reconciles only the difference', async () => {
    // Not a dot-directory: tsconfig `include` skips those, and tsx would then compile the JSX classically.
    const dir = `${projectRoot}test/tmp-watch`;
    const file = `${dir}/app.tsx`;
    const app = (replicas: number) => `
      import { Container, ReplicaSet } from 'fiber-servo';
      export default () => (
        <ReplicaSet name="web" replicas={${replicas}}>
          <Container image="nginx" />
        </ReplicaSet>
      );
    `;
    await mkdir(dir, { recursive: true });
    await writeFile(file, app(1));

    const up = cli(['up', '--watch', '--runtime', 'memory', file]);
    try {
      await up.until('create web-0');
      await up.until(`watching ${file}`);
      await writeFile(file, app(2));
      await up.until('create web-1');
      // web-0's spec did not change (only the replica count did), so its
      // spec digest matches what it was created from and it is left alone:
      // one creation, ever, and no removal.
      expect(up.output().match(/create web-0/g)).toHaveLength(1);
      expect(up.output()).not.toContain('remove web-0');

      await up.stop();
      expect(up.output()).toContain('remove web-1');
      expect(up.output()).toContain('remove web-0');
    } finally {
      await up.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('declarative examples', () => {
  it.each([
    ['basic', 1, ['web']],
    ['replicaset', 3, ['api-0', 'api-1', 'api-2']],
    ['webapp', 6, ['db', 'migrate', 'api']],
    ['app', 4, ['db', 'web']],
  ] as const)(
    'plans %s through the source CLI',
    async (name, count, expected) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', 'plan', `examples/${name}.tsx`, '--model'],
        { cwd: projectRoot, timeout: 30_000 },
      );
      const model = JSON.parse(stdout) as { services: Record<string, unknown> };
      expect(Object.keys(model.services)).toHaveLength(count);
      for (const service of expected) expect(model.services).toHaveProperty(service);
    },
    30_000,
  );
});
