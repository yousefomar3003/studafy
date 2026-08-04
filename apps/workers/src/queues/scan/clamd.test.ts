/**
 * Clamd client tests (file-scan queue).
 *
 * The client is tested against a real TCP server so the INSTREAM framing — preamble, length-prefixed
 * chunks, zero-length terminator, NUL-terminated verdict — is exercised byte-for-byte. The server is
 * a minimal in-process parser of the protocol, which doubles as the spec: if the client ever sends
 * something clamd would not understand, the parser stalls instead of passing.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { ClamdScanError, parseClamdResponse, scanStream } from "./clamd";
import { startFakeClamd, startSilentServer } from "./test-clamd-server";

import type { ClamdConfig } from "./clamd";

const baseConfig = (overrides: Partial<ClamdConfig> = {}): ClamdConfig => ({
  host: "127.0.0.1",
  port: 0,
  timeoutMs: 2_000,
  maxFileBytes: 25 * 1024 * 1024,
  ...overrides,
});

async function* fromBuffer(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

describe("parseClamdResponse", () => {
  test("a clean verdict", () => {
    expect(parseClamdResponse("stream: OK\0")).toEqual({ kind: "clean" });
  });

  test("an infected verdict captures the signature name", () => {
    expect(parseClamdResponse("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({
      kind: "infected",
      virus: "Win.Test.EICAR_HDB-1",
    });
  });

  test("trailing whitespace before the NUL terminator is tolerated", () => {
    expect(parseClamdResponse("stream: OK \0")).toEqual({ kind: "clean" });
  });

  test("an ERROR line is an error verdict", () => {
    expect(parseClamdResponse("stream: ERROR\0")).toEqual({
      kind: "error",
      message: "stream: ERROR",
    });
  });

  test("garbage is an error verdict, never silently clean", () => {
    expect(parseClamdResponse("hello\0")).toEqual({ kind: "error", message: "hello" });
  });

  test("an empty response is a named error", () => {
    expect(parseClamdResponse("")).toEqual({ kind: "error", message: "empty clamd response" });
  });
});

describe("scanStream", () => {
  test("streams the exact bytes and returns a clean verdict", async () => {
    const fake = await startFakeClamd(() => "stream: OK");
    try {
      const bytes = new TextEncoder().encode("hello clamd, this is a clean file");
      const verdict = await scanStream(fromBuffer(bytes), baseConfig({ port: fake.port }));
      expect(verdict).toEqual({ kind: "clean" });
      expect(Buffer.from(fake.receivedPayload()).equals(bytes)).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("frames a large object in multiple 1 MiB chunks without loss", async () => {
    const fake = await startFakeClamd(() => "stream: OK");
    try {
      const bytes = new Uint8Array(2 * 1024 * 1024 + 4097);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
      const verdict = await scanStream(fromBuffer(bytes), baseConfig({ port: fake.port }));
      expect(verdict).toEqual({ kind: "clean" });
      const received = Buffer.from(fake.receivedPayload());
      expect(received.length).toBe(bytes.length);
      expect(Buffer.from(bytes).equals(received)).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("returns the signature name for an infected verdict", async () => {
    const fake = await startFakeClamd(() => "stream: Win.Test.EICAR_HDB-1 FOUND");
    try {
      const verdict = await scanStream(
        fromBuffer(new TextEncoder().encode("EICAR-TEST")),
        baseConfig({ port: fake.port }),
      );
      expect(verdict).toEqual({ kind: "infected", virus: "Win.Test.EICAR_HDB-1" });
    } finally {
      await fake.close();
    }
  });

  test("surfaces clamd's scan error without inventing a verdict", async () => {
    const fake = await startFakeClamd(() => "stream: ERROR");
    try {
      const verdict = await scanStream(
        fromBuffer(new TextEncoder().encode("whatever")),
        baseConfig({ port: fake.port }),
      );
      expect(verdict.kind).toBe("error");
    } finally {
      await fake.close();
    }
  });

  test("fails fast when the object exceeds maxFileBytes", async () => {
    const fake = await startFakeClamd(() => "stream: OK");
    try {
      await expect(
        scanStream(
          fromBuffer(new Uint8Array(1000)),
          baseConfig({ port: fake.port, maxFileBytes: 10 }),
        ),
      ).rejects.toBeInstanceOf(ClamdScanError);
    } finally {
      await fake.close();
    }
  });

  test("times out with a ClamdScanError when clamd never answers", async () => {
    const fake = await startSilentServer();
    try {
      await expect(
        scanStream(
          fromBuffer(new TextEncoder().encode("stuck")),
          baseConfig({ port: fake.port, timeoutMs: 150 }),
        ),
      ).rejects.toBeInstanceOf(ClamdScanError);
    } finally {
      await fake.close();
    }
  });

  test("rejects with a ClamdScanError when nothing is listening", async () => {
    const fake = await startSilentServer();
    await fake.close();
    await expect(
      scanStream(fromBuffer(new TextEncoder().encode("nowhere")), baseConfig({ port: fake.port })),
    ).rejects.toBeInstanceOf(ClamdScanError);
  });
});
