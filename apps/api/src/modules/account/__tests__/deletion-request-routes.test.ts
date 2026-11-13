/**
 * The public deletion endpoints are reachable the way Google Play's reviewer reaches them: no app,
 * no session, no CSRF cookie. Built on the full createApp stack so the JWT, CSRF and rate-limit
 * middleware are the real ones. Redis is absent, so a request that gets past all of them ends at the
 * route's own 503 — which is the proof it got past them.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../../app";
import { resetSecurityConfig } from "../../../config/security";
import { createInflightTracker } from "../../../lifecycle";
import { createLogger } from "../../../logger";
import { KeyStore } from "../../auth";

import type { Database } from "../../../db/client";

let keyStore: KeyStore;
let app: ReturnType<typeof createApp>;

const database = (() => {
  throw new Error("no database in this test");
}) as unknown as Database;

beforeAll(async () => {
  keyStore = new KeyStore(60_000);
  await keyStore.init();
  resetSecurityConfig();
  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    database,
    keyStore,
  });
});

afterAll(() => keyStore.destroy());

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("public account deletion routes", () => {
  test("the request endpoint needs no session or CSRF cookie", async () => {
    const res = await post("/api/account/deletion-requests", {
      email: "parent@example.com",
      captcha_token: "t",
    });

    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("DSR_UNAVAILABLE");
  });

  test("the confirm endpoint needs no session or CSRF cookie", async () => {
    const res = await post("/api/account/deletion-requests/confirm", { token: "a".repeat(64) });

    expect(res.status).toBe(503);
  });

  test("the signed-in deletion endpoint stays protected", async () => {
    const res = await post("/api/account/deletion", {});

    expect([401, 403]).toContain(res.status);
  });

  test("an invalid email is rejected before anything else happens", async () => {
    const res = await post("/api/account/deletion-requests", {
      email: "not-an-email",
      captcha_token: "t",
    });

    expect(res.status).toBe(400);
  });
});
