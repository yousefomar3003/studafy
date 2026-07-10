// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApp } from "./app";
import { createInflightTracker } from "./lifecycle";

const buildApp = (isReady: () => boolean) =>
  createApp({ isReady, tracker: createInflightTracker() });

describe("security headers", () => {
  test("every response sets Strict-Transport-Security", async () => {
    const res = await buildApp(() => true).request("/healthz");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });
});
