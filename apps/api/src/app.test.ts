// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApp } from "./app";
import { createInflightTracker } from "./lifecycle";
import { createLogger } from "./logger";

// A logger writing nowhere: these tests assert on responses, and a run must not emit NDJSON.
const silentLogger = () => createLogger({ destination: () => undefined });

const buildApp = (isReady: () => boolean) =>
  createApp({ isReady, tracker: createInflightTracker(), logger: silentLogger() });

describe("security headers", () => {
  test("every response sets Strict-Transport-Security", async () => {
    const res = await buildApp(() => true).request("/healthz");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });
});
