/**
 * The client half: connect, send one request, stream the reply, exit.
 *
 * It is deliberately thin. Nothing here knows what an app is; it moves lines
 * and hands back the `done` that decides the exit code. The evaluation lives
 * in the daemon, which is the whole point of sending a path (decision 21).
 */
import { connect } from 'node:net';
import {
  createMessageDecoder,
  defaultSocketPath,
  encodeMessage,
  type DaemonRequest,
  type DaemonResponse,
  type DoneResponse,
} from './protocol.js';

export interface ClientOptions {
  socketPath?: string;
  /** Called for every line before `done`, in order. */
  onMessage?: (message: DaemonResponse) => void;
}

function connectionError(error: NodeJS.ErrnoException, socketPath: string): Error {
  if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
    return new Error(
      `fiber-servo: no daemon listening on ${socketPath} (start one with "fiber-servo daemon")`,
    );
  }
  return new Error(`fiber-servo: ${socketPath}: ${error.message}`);
}

/** Send one request and resolve with the `done` line that ends the reply. */
export function sendRequest(request: DaemonRequest, options: ClientOptions = {}): Promise<DoneResponse> {
  const socketPath = options.socketPath ?? defaultSocketPath();
  return new Promise((settle, fail) => {
    const socket = connect(socketPath);
    const decode = createMessageDecoder<DaemonResponse>();
    let done: DoneResponse | undefined;

    socket.setNoDelay(true);
    socket.on('connect', () => socket.write(encodeMessage(request)));
    socket.on('data', (chunk) => {
      let messages: DaemonResponse[];
      try {
        messages = decode(chunk);
      } catch (error) {
        socket.destroy();
        fail(new Error(`fiber-servo: unreadable reply from ${socketPath}: ${String(error)}`));
        return;
      }
      for (const message of messages) {
        if (message.type === 'done') {
          done = message;
          socket.end();
        } else options.onMessage?.(message);
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => fail(connectionError(error, socketPath)));
    socket.on('close', () => {
      if (done !== undefined) settle(done);
      // Already rejected on 'error' in the usual case; this covers a daemon
      // that died mid-reply, where the socket just closes.
      else fail(new Error(`fiber-servo: ${socketPath} closed the connection without answering`));
    });
  });
}
