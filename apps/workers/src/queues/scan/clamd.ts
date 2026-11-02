/**
 * ClamAV clamd client for the file-scan queue.
 *
 * Talks the raw clamd INSTREAM protocol over TCP rather than shelling out to `clamscan`, because
 * the workers run on Fargate with no shared filesystem: the object to scan lives in S3 and is
 * streamed straight into the connection, never written to a temp file. INSTREAM is the protocol
 * for exactly that — the caller sends a length-prefixed byte stream and clamd answers with a
 * single verdict line terminated by NUL.
 *
 *   request  : "zINSTREAM\0", then per chunk a 4-byte big-endian length followed by the chunk
 *              bytes, terminated by a zero-length chunk.
 *   response : "stream: OK\0"               — clean
 *              "stream: <signature> FOUND\0" — infected, <signature> is the ClamAV signature name
 *              "stream: ERROR\0"            — clamd refused (oversized, malformed request)
 *
 * The object is framed in 1 MiB chunks. The 4-byte length field allows far larger chunks, but
 * 1 MiB is the size every clamd build accepts and it bounds per-connection memory.
 *
 * `maxFileBytes` mirrors clamd's `StreamMaxLength` (default 25 MiB in both places). clamd would
 * reject a larger stream with ERROR on its own; failing fast here stops us streaming megabytes of
 * a file we already know we will not get a verdict for.
 */

import { createConnection } from "node:net";

import type { Socket } from "node:net";

export interface ClamdConfig {
  host: string;
  port: number;
  timeoutMs: number;
  maxFileBytes: number;
}

export type ScanVerdict =
  { kind: "clean" } | { kind: "infected"; virus: string } | { kind: "error"; message: string };

/** Thrown when clamd cannot be reached or does not answer. The worker retries; it never fakes a verdict. */
export class ClamdScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClamdScanError";
  }
}

const INSTREAM_PREAMBLE = Buffer.from("zINSTREAM\0", "utf8");
const CHUNK_SIZE = 1024 * 1024;
/** A verdict line is short; anything longer than this is not a verdict, whatever clamd sent. */
const MAX_RESPONSE_BYTES = 4096;

/**
 * Parse a clamd INSTREAM response line into a verdict.
 *
 * The raw response is NUL-terminated; strip the terminator and any trailing whitespace before
 * matching. Anything that is not a clean or FOUND line is an error verdict — clamd only emits
 * `stream: ERROR` for a request it could not scan, so there is no legitimate third shape.
 */
export function parseClamdResponse(raw: string): ScanVerdict {
  const text = raw.replace(/\0+$/, "").trim();
  if (text === "stream: OK") return { kind: "clean" };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) return { kind: "infected", virus: found[1]! };
  return { kind: "error", message: text === "" ? "empty clamd response" : text };
}

/**
 * Write one length-prefixed INSTREAM frame. Resolves once the frame is flushed to the socket, so
 * backpressure bounds memory on large objects.
 */
function writeFrame(socket: Socket, frame: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(frame.byteLength, 0);
    socket.write(header, (error) => {
      if (error) reject(error);
    });
    socket.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Stream `body` to clamd and resolve with the verdict.
 *
 * `body` is an async iterable of bytes — exactly the shape of an S3 `GetObjectCommand` body, so
 * the object is never held in memory whole. The connection is torn down either way once the
 * verdict arrives; a socket left open would hold a connection against a service that is expensive
 * to over-subscribe.
 */
export async function scanStream(
  body: AsyncIterable<Uint8Array>,
  config: ClamdConfig,
): Promise<ScanVerdict> {
  const socket = createConnection({ host: config.host, port: config.port });

  return await new Promise<ScanVerdict>((resolve, reject) => {
    let settled = false;
    let bytesSent = 0;
    const response: Buffer[] = [];
    let responseBytes = 0;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new ClamdScanError(message));
    };

    const succeed = (verdict: ScanVerdict) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(verdict);
    };

    socket.setTimeout(config.timeoutMs, () => {
      fail(`clamd timed out after ${config.timeoutMs}ms`);
    });
    socket.on("error", (error) => {
      fail(`clamd connection error: ${error.message}`);
    });

    socket.on("data", (chunk: Buffer) => {
      responseBytes += chunk.length;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        fail("clamd response exceeded the verdict-size limit");
        return;
      }
      response.push(chunk);
      if (chunk.includes(0)) {
        succeed(parseClamdResponse(Buffer.concat(response).toString("utf8")));
      }
    });

    socket.on("connect", async () => {
      try {
        socket.write(INSTREAM_PREAMBLE);
        for await (const chunk of body) {
          if (settled) return;
          bytesSent += chunk.byteLength;
          if (bytesSent > config.maxFileBytes) {
            fail(`object exceeds clamd max scan size of ${config.maxFileBytes} bytes`);
            return;
          }
          let offset = 0;
          while (offset < chunk.byteLength) {
            if (settled) return;
            const frame = chunk.subarray(offset, Math.min(offset + CHUNK_SIZE, chunk.byteLength));
            await writeFrame(socket, frame);
            offset += frame.byteLength;
          }
        }
        if (settled) return;
        // The zero-length chunk tells clamd the stream is complete and to scan it.
        await writeFrame(socket, new Uint8Array(0));
      } catch (error) {
        fail(error instanceof Error ? error.message : "clamd stream write failed");
      }
    });
  });
}
