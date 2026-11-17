import { createServer } from "node:net";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { createScannerWarmup } from "../scanner-warmup";

import type { AddressInfo, Server } from "node:net";

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** A stand-in clamd: records every connection's bytes and answers PONG. */
async function fakeClamd(): Promise<{ port: number; received: string[] }> {
  const received: string[] = [];
  server = createServer((socket) => {
    socket.on("data", (chunk) => {
      received.push(chunk.toString("utf8"));
      socket.end("PONG\0");
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { port: (server!.address() as AddressInfo).port, received };
}

async function until(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("createScannerWarmup", () => {
  test("knocks with clamd's zPING", async () => {
    const clamd = await fakeClamd();
    const warm = createScannerWarmup({ host: "127.0.0.1", port: clamd.port });

    expect(warm()).toBeUndefined();

    await until(() => clamd.received.length === 1);
    expect(clamd.received[0]).toBe("zPING\0");
  });

  test("knocks at most once per throttle window", async () => {
    const clamd = await fakeClamd();
    let clock = 0;
    const warm = createScannerWarmup({
      host: "127.0.0.1",
      port: clamd.port,
      throttleMs: 30_000,
      now: () => clock,
    });

    warm();
    warm();
    clock = 29_999;
    warm();
    await until(() => clamd.received.length === 1);
    clock = 30_000;
    warm();
    await until(() => clamd.received.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clamd.received).toHaveLength(2);
  });

  test("never throws when nothing listens or the host does not resolve", async () => {
    const refused = createScannerWarmup({ host: "127.0.0.1", port: 1, timeoutMs: 200 });
    const unresolvable = createScannerWarmup({
      host: "scanner.invalid",
      port: 3310,
      timeoutMs: 200,
    });

    expect(() => refused()).not.toThrow();
    expect(() => unresolvable()).not.toThrow();
    // Give the failed connections time to error out; an unhandled 'error' would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
});
