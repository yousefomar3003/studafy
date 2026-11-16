// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../app";
import { createUnusableDatabase } from "../db/unusable";
import { createInflightTracker } from "../lifecycle";
import { createLogger } from "../logger";

import { signResendPayload } from "./resend-signature";

/**
 * Pre-database webhook tests (deliverability R-08), mirroring the ERPNext webhook suite: every case
 * here returns before the handler touches the database, which is why createUnusableDatabase suffices
 * and this runs in the `quality` job with no Postgres. The paths that do reach the database — the
 * happy 200 (ledger insert, suppression upsert, delivery transition) and dedup — need a real
 * database; they live in tests/email/webhook.db.test.ts, which the `api-integration` job runs.
 */

const SECRET = `whsec_${Buffer.from("studafy-webhook-unit-test-key-0001").toString("base64")}`;

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  request_id: string;
}

let previousSecret: string | undefined;

beforeEach(() => {
  previousSecret = process.env.RESEND_WEBHOOK_SECRET;
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  if (previousSecret === undefined) {
    delete process.env.RESEND_WEBHOOK_SECRET;
  } else {
    process.env.RESEND_WEBHOOK_SECRET = previousSecret;
  }
});

function build() {
  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    redis: null,
    database: createUnusableDatabase(),
  });
  return { app };
}

function delivered(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "email.delivered",
    created_at: "2026-11-09T19:44:00.000Z",
    data: { email_id: "re-email-1", to: ["parent@example.com"] },
    ...overrides,
  };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function post(
  app: ReturnType<typeof build>["app"],
  body: string | object,
  options: { secret?: string; timestamp?: number; headers?: Record<string, string> } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const id = "msg_unit_1";
  const timestamp = String(options.timestamp ?? nowSeconds());
  return app.request("/email/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signResendPayload(options.secret ?? SECRET, id, timestamp, raw),
      ...options.headers,
    },
    body: raw,
  });
}

describe("webhook configuration", () => {
  test("answers 500 problem+json when RESEND_WEBHOOK_SECRET is unconfigured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const { app } = build();

    const res = await post(app, delivered());
    const problem = (await res.json()) as Problem;

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(problem.request_id).toBeString();
  });
});

describe("signature verification", () => {
  test("rejects a signature made with the wrong secret with 401", async () => {
    const { app } = build();
    const attacker = `whsec_${Buffer.from("someone-else").toString("base64")}`;

    const res = await post(app, delivered(), { secret: attacker });
    const problem = (await res.json()) as Problem;

    expect(res.status).toBe(401);
    expect(problem.code).toBe("AUTH_TOKEN_INVALID");
    expect(problem.request_id).toBeString();
  });

  test("rejects a request with no signature headers with 401", async () => {
    const { app } = build();

    const res = await app.request("/email/webhooks/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(delivered()),
    });

    expect(res.status).toBe(401);
  });

  test("rejects a tampered body with 401", async () => {
    const { app } = build();
    const raw = JSON.stringify(delivered());
    const timestamp = String(nowSeconds());

    const res = await app.request("/email/webhooks/resend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_unit_1",
        "svix-timestamp": timestamp,
        "svix-signature": signResendPayload(SECRET, "msg_unit_1", timestamp, raw),
      },
      body: raw.replace("email.delivered", "email.complained"),
    });

    expect(res.status).toBe(401);
  });

  test("rejects a replay outside the five-minute window with 401", async () => {
    const { app } = build();

    const res = await post(app, delivered(), { timestamp: nowSeconds() - 10 * 60 });

    expect(res.status).toBe(401);
  });
});

describe("event handling", () => {
  test("rejects a signed body that is not a JSON object with 400", async () => {
    const { app } = build();

    const res = await post(app, "[1,2,3]");

    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("VALIDATION_FAILED");
  });

  test("answers 400 when an acted-on event has no email_id", async () => {
    const { app } = build();

    const res = await post(app, delivered({ data: { to: ["parent@example.com"] } }));

    expect(res.status).toBe(400);
  });

  test("answers 400 when a complaint names no recipient", async () => {
    const { app } = build();

    const res = await post(
      app,
      delivered({ type: "email.complained", data: { email_id: "re-email-1", to: [] } }),
    );

    expect(res.status).toBe(400);
  });

  test("answers 200 for a knowingly-ignored event type", async () => {
    const { app } = build();

    for (const type of ["email.delivery_delayed", "email.opened"]) {
      const res = await post(app, delivered({ type }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
  });

  test("answers 200 for a non-email event with no email_id", async () => {
    const { app } = build();

    const res = await post(app, { type: "contact.created", data: { id: "c-1" } });

    expect(res.status).toBe(200);
  });

  test("answers 500 when ingestion fails before touching the database", async () => {
    const { app } = build();

    const res = await post(app, delivered());

    // The unusable database throws on the first query; errorHandlerMiddleware withholds the cause.
    expect(res.status).toBe(500);
    expect(((await res.json()) as Problem).request_id).toBeString();
  });
});
