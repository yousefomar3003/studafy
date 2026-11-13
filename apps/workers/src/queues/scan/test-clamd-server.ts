/**
 * A fake clamd TCP server for the file-scan tests (not a test file itself).
 *
 * It parses the INSTREAM request — preamble, length-prefixed chunks, zero-length terminator — into
 * its exact payload bytes and answers with `respond(payload)`. The received payload is the proof of
 * correct framing, and the parser doubling as the protocol spec means a client that sends something
 * clamd would not understand stalls instead of passing.
 */

import { createServer } from "node:net";

import type { Server, Socket } from "node:net";

const PREAMBLE = Buffer.from("zINSTREAM\0", "utf8");
const PING = Buffer.from("zPING\0", "utf8");

/**
 * `options.resetFirst` drops that many connections as soon as they arrive, before reading anything —
 * what a client sees from fly's proxy while an on-demand clamd machine is still booting. A PING
 * (the readiness probe) is answered PONG; any other request must be INSTREAM.
 */
export async function startFakeClamd(
  respond: (payload: Buffer) => string,
  options: { resetFirst?: number } = {},
): Promise<{
  port: number;
  receivedPayload: () => Buffer;
  connections: () => number;
  close: () => Promise<void>;
}> {
  const payload: Buffer[] = [];
  let connections = 0;
  const server: Server = createServer((socket: Socket) => {
    connections += 1;
    if (connections <= (options.resetFirst ?? 0)) {
      socket.destroy();
      return;
    }
    let buffer = Buffer.alloc(0);
    let stage: "preamble" | "length" | "data" = "preamble";
    let frameLength = 0;

    const parse = (): Buffer | null => {
      for (;;) {
        if (stage === "preamble") {
          if (buffer.length < PREAMBLE.length) return null;
          if (!buffer.subarray(0, PREAMBLE.length).equals(PREAMBLE)) {
            socket.destroy();
            throw new Error("clamd test: malformed preamble");
          }
          buffer = buffer.subarray(PREAMBLE.length);
          stage = "length";
          continue;
        }
        if (stage === "length") {
          if (buffer.length < 4) return null;
          frameLength = buffer.readUInt32BE(0);
          buffer = buffer.subarray(4);
          if (frameLength === 0) return Buffer.concat(payload);
          stage = "data";
          continue;
        }
        if (buffer.length < frameLength) return null;
        payload.push(buffer.subarray(0, frameLength));
        buffer = buffer.subarray(frameLength);
        stage = "length";
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (
        stage === "preamble" &&
        buffer.length >= PING.length &&
        buffer.subarray(0, PING.length).equals(PING)
      ) {
        socket.end("PONG\0");
        return;
      }
      const complete = parse();
      if (complete) {
        socket.end(`${respond(complete)}\0`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    port,
    receivedPayload: () => Buffer.concat(payload),
    connections: () => connections,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * A server that accepts connections and never answers — for the timeout path.
 *
 * `close` destroys the accepted sockets itself: `server.close()` waits for open connections, and
 * the client destroying its end does not reliably end the server side, so it would hang otherwise.
 */
export async function startSilentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
