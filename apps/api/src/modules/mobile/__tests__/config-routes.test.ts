// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApp } from "../../../app";
import { createInflightTracker } from "../../../lifecycle";
import { createLogger } from "../../../logger";
import { KeyStore } from "../../auth";
import { EMPTY_MOBILE_RELEASE_CONFIG } from "../config";

import type { MobileReleaseConfig } from "../schemas";

const buildApp = (mobileReleaseConfig?: MobileReleaseConfig) =>
  createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    ...(mobileReleaseConfig ? { mobileReleaseConfig } : {}),
  });

const SAMPLE: MobileReleaseConfig = {
  ios: { minimum_supported_version: "1.2.0", latest_version: "1.5.1" },
  android: { minimum_supported_version: "1.3.0", latest_version: "1.5.0" },
};

describe("GET /api/mobile/config", () => {
  test("echoes the configured floor and latest versions", async () => {
    const res = await buildApp(SAMPLE).request("/api/mobile/config");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(SAMPLE);
  });

  test("defaults every field to 0.0.0 when no config is supplied", async () => {
    const res = await buildApp().request("/api/mobile/config");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY_MOBILE_RELEASE_CONFIG);
  });

  test("carries the X-Request-Id correlation header", async () => {
    const res = await buildApp(SAMPLE).request("/api/mobile/config");

    expect(res.headers.get("X-Request-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("is reachable without a bearer token even with the auth boundary mounted", async () => {
    const keyStore = new KeyStore(60_000);
    await keyStore.init();
    const app = createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
      keyStore,
      mobileReleaseConfig: SAMPLE,
    });

    const res = await app.request("/api/mobile/config");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAMPLE);
  });
});
