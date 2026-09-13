/** Local session control. No desired state is stored here: apply re-evaluates the session's file. */
import { createHash } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ApplyResult {
  ok: boolean;
  ops: string[];
  errors: string[];
}

export function sessionAddress(file: string): string {
  const identity = process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file);
  const key = createHash('sha256').update(`${homedir()}:${identity}`).digest('hex').slice(0, 24);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\fiber-servo-${key}`
    : join(tmpdir(), `fiber-servo-${process.getuid!()}`, `${key}.sock`);
}

export async function listenSession(
  file: string,
  apply: () => Promise<ApplyResult>,
): Promise<() => Promise<void>> {
  const address = sessionAddress(file);
  if (process.platform !== 'win32') {
    const { dirname } = await import('node:path');
    await mkdir(dirname(address), { recursive: true, mode: 0o700 });
    await chmod(dirname(address), 0o700);
  }
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    socket.setEncoding('utf8');
    let input = '';
    const receive = (chunk: string) => {
      input += chunk;
      if (input.length > 1024) return socket.destroy();
      if (!input.includes('\n')) return;
      socket.removeListener('data', receive);
      socket.setTimeout(0);
      if (input.trim() !== 'apply') {
        socket.end(JSON.stringify({ ok: false, ops: [], errors: ['Unknown session command'] }) + '\n');
        return;
      }
      void apply().then(
        (result) => socket.end(JSON.stringify(result) + '\n'),
        (error: unknown) =>
          socket.end(JSON.stringify({ ok: false, ops: [], errors: [String(error)] }) + '\n'),
      );
    };
    socket.on('data', receive);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  };
}

export function requestApply(file: string, timeoutMs = 120_000): Promise<ApplyResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sessionAddress(file));
    let input = '';
    let finished = false;
    const fail = (error: Error) => {
      finished = true;
      socket.destroy();
      reject(error);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () =>
      fail(new Error('Apply timed out; it may still be running. Check the up process before retrying.')),
    );
    socket.on('error', (error) =>
      fail(
        new Error(
          `Cannot contact session for ${file}: ${error.message}. Start fiber-servo up for this file first.`,
        ),
      ),
    );
    socket.on('connect', () => socket.write('apply\n'));
    socket.on('data', (chunk: string) => {
      input += chunk;
      if (input.length > 8 * 1024 * 1024) return fail(new Error('Session response too large'));
      if (!input.includes('\n')) return;
      try {
        const result = JSON.parse(input.slice(0, input.indexOf('\n'))) as ApplyResult;
        if (typeof result.ok !== 'boolean' || !Array.isArray(result.ops) || !Array.isArray(result.errors))
          throw new Error('Invalid session response');
        finished = true;
        socket.destroy();
        resolve(result);
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
    socket.on('close', () => {
      if (!finished) fail(new Error('Session closed before acknowledging apply; its outcome is unknown.'));
    });
  });
}
