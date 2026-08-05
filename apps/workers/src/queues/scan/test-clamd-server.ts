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

export async function startFakeClamd(
  respond: (payload: Buffer) => string,
): Promise<{ port: number; receivedPayload: () => Buffer; close: () => Promise<void> }> {
  const payload: Buffer[] = [];
  const server: Server = createServer((socket: Socket) => {
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A server that accepts connections and never answers — for the timeout path. */
export async function startSilentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
