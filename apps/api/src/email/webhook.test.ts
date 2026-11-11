import { createHmac } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../app";
import { createUnusableDatabase } from "../db/unusable";
import { createInflightTracker } from "../lifecycle";
import { createLogger } from "../logger";

/**
 * Pre-database webhook tests (deliverability R-08), mirroring the ERPNext webhook suite: every case
 * here returns before the handler touches the database, or fails on it, which is why
 * createUnusableDatabase suffices and this runs in the `quality` job with no Postgres. The paths that
 * do reach the database — the happy 200 (ledger insert, suppression upsert, delivery transition) and
 * dedup — need a real database; they live in tests/email/webhook.db.test.ts, which the
 * `api-integration` job runs.
 */

const RESEND_SECRET = `whsec_${Buffer.from("resend-webhook-unit-key").toString("base64")}`;
let previousSecret: string | undefined;

beforeEach(() => {
  previousSecret = process.env.RESEND_WEBHOOK_SECRET;
  process.env.RESEND_WEBHOOK_SECRET = RESEND_SECRET;
});

afterEach(() => {
  if (previousSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
  else process.env.RESEND_WEBHOOK_SECRET = previousSecret;
});

function build() {
  const lines: string[] = [];
  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: (line) => lines.push(line) }),
    redis: null,
    database: createUnusableDatabase(),
  });
  return { app, lines };
}

function resendPost(
  app: ReturnType<typeof build>["app"],
  body: string,
  signature?: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const key = Buffer.from(RESEND_SECRET.slice(6), "base64");
  const valid = `v1,${createHmac("sha256", key).update(`msg_1.${timestamp}.${body}`).digest("base64")}`;
  return app.request("/email/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": "msg_1",
      "svix-timestamp": timestamp,
      "svix-signature": signature ?? valid,
    },
    body,
  });
}

describe("Resend webhook", () => {
  test("answers 500 when RESEND_WEBHOOK_SECRET is not configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await resendPost(build().app, "{}");
    expect(res.status).toBe(500);
  });

  test("refuses an unsigned or wrongly signed event with 401", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { email_id: "e1" } });
    const res = await resendPost(build().app, body, "v1,AAAA");
    expect(res.status).toBe(401);
  });

  test("refuses a stale event with 401, so a captured request cannot be replayed", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { email_id: "e1" } });
    const old = String(Math.floor(Date.now() / 1000) - 600);
    const res = await resendPost(build().app, body, undefined, old);
    expect(res.status).toBe(401);
  });

  test("ignores a signed event type it does not act on, without touching the database", async () => {
    const body = JSON.stringify({ type: "email.opened", data: { email_id: "e1" } });
    const res = await resendPost(build().app, body);
    expect(res.status).toBe(200);
  });

  test("answers 400 for a signed bounce with no recipient", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { email_id: "e1" } });
    const res = await resendPost(build().app, body);
    expect(res.status).toBe(400);
  });

  test("answers 500 problem+json when ingestion fails", async () => {
    const body = JSON.stringify({
      type: "email.bounced",
      data: { email_id: "e1", to: ["parent@example.com"] },
    });
    const res = await resendPost(build().app, body);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
});
