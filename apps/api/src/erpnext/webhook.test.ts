import { createHmac } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../app";
import { createUnusableDatabase } from "../db/unusable";
import { createInflightTracker } from "../lifecycle";
import { createLogger } from "../logger";

/**
 * ST-060: the webhook's failure responses are RFC 9457 problem+json, and their statuses are
 * unchanged from before the conversion (ERPNext reads the status, not the body).
 *
 * Every case here returns before the handler touches the database, which is why createUnusableDatabase
 * suffices and this runs in the `quality` job with no Postgres. The paths that do reach the database
 * — the happy-path 200 (dedup + audit + outbox rows) and the ingestion-failure 500 — live in
 * tests/erpnext/webhook.db.test.ts, run by the `api-integration` job.
 */

const SECRET = "test-webhook-secret";

const sign = (body: string, secret = SECRET): string =>
  createHmac("sha256", secret).update(body).digest("hex");

const build = () => {
  const lines: string[] = [];
  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: (line) => lines.push(line) }),
    redis: null,
    database: createUnusableDatabase(),
  });
  return { app, lines };
};

interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  request_id: string;
}

const post = (app: ReturnType<typeof build>["app"], body: string, signature?: string) =>
  app.request("/erpnext/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature === undefined ? {} : { "x-erpnext-signature": signature }),
    },
    body,
  });

const VALID_BODY = JSON.stringify({
  event_id: "evt-1",
  doctype: "Sales Invoice",
  action: "submitted",
  data: { school_id: "8f14e45f-ceea-4a67-9a2d-1c3e7b0d5a91", name: "SINV-001" },
});

let previousSecret: string | undefined;

beforeEach(() => {
  previousSecret = process.env.ERPNEXT_WEBHOOK_SECRET;
  process.env.ERPNEXT_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  if (previousSecret === undefined) {
    delete process.env.ERPNEXT_WEBHOOK_SECRET;
  } else {
    process.env.ERPNEXT_WEBHOOK_SECRET = previousSecret;
  }
});

describe("signature verification", () => {
  test("rejects a missing signature with 401 problem+json", async () => {
    const { app } = build();

    const res = await post(app, VALID_BODY);
    const problem = (await res.json()) as Problem;

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(problem.code).toBe(ERROR_CODES.AUTH_TOKEN_INVALID);
    expect(problem.request_id).toBeString();
  });

  test("rejects a wrong signature with 401", async () => {
    const { app } = build();

    const res = await post(app, VALID_BODY, sign(VALID_BODY, "the-wrong-secret"));

    expect(res.status).toBe(401);
    expect(((await res.json()) as Problem).code).toBe(ERROR_CODES.AUTH_TOKEN_INVALID);
  });

  // The signature covers the exact bytes ERPNext sent. If anything ever re-serializes the body
  // before verification, the digest stops matching and this fails — which is the alarm we want,
  // because the alternative is a signature check that silently passes on attacker-modified bytes.
  test("accepts a signature over the raw bytes, including insignificant whitespace", async () => {
    const { app } = build();
    const spaced =
      '{\n  "event_id":  "evt-2",\n  "doctype": "Unknown DocType",\n  "action": "submitted",\n  "data": {}\n}';

    const res = await post(app, spaced, sign(spaced));

    expect(res.status).toBe(200);
  });

  // Authenticate, then parse. An unsigned caller must not get schema feedback, and must not have
  // its JSON parsed on our behalf.
  test("checks the signature before parsing the body", async () => {
    const { app } = build();

    const res = await post(app, "this is not json", "deadbeef");

    expect(res.status).toBe(401);
  });
});

describe("body validation", () => {
  test("rejects malformed JSON with 400 problem+json", async () => {
    const { app } = build();
    const body = "this is not json";

    const res = await post(app, body, sign(body));
    const problem = (await res.json()) as Problem;

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(problem.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("rejects a schema-invalid body with 400 and a detail", async () => {
    const { app } = build();
    const body = JSON.stringify({
      event_id: "",
      doctype: "Sales Invoice",
      action: "submitted",
      data: {},
    });

    const res = await post(app, body, sign(body));
    const problem = (await res.json()) as Problem;

    expect(res.status).toBe(400);
    expect(problem.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    // 4xx detail is safe to echo: it is authored here, from z.prettifyError, and names the field.
    expect(problem.detail).toContain("event_id");
  });

  test("rejects a payload with no school_id with 400", async () => {
    const { app } = build();
    const body = JSON.stringify({
      event_id: "evt-3",
      doctype: "Sales Invoice",
      action: "submitted",
      data: { name: "SINV-002" },
    });

    const res = await post(app, body, sign(body));

    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });
});

describe("secret configuration", () => {
  test("answers 500 with no detail when the secret is unset", async () => {
    delete process.env.ERPNEXT_WEBHOOK_SECRET;
    const { app } = build();

    const res = await post(app, VALID_BODY, sign(VALID_BODY));
    const problem = (await res.json()) as Problem;

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(problem.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    // A caller must never learn that our secret is missing; the operator reads it from the log.
    expect(problem.detail).toBeUndefined();
  });

  test("logs the missing variable by name for the operator", async () => {
    delete process.env.ERPNEXT_WEBHOOK_SECRET;
    const { app, lines } = build();

    await post(app, VALID_BODY, sign(VALID_BODY));

    expect(lines.join("\n")).toContain("ERPNEXT_WEBHOOK_SECRET");
  });
});

describe("known-but-unmapped events", () => {
  // A doctype we do not map is delivered, understood, and deliberately ignored. Answering an error
  // would make ERPNext retry it forever.
  test("answers 200 without reaching the database", async () => {
    const { app } = build();
    const body = JSON.stringify({
      event_id: "evt-4",
      doctype: "Unknown DocType",
      action: "submitted",
      data: {},
    });

    const res = await post(app, body, sign(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("every response", () => {
  test("carries an X-Request-Id header", async () => {
    const { app } = build();

    const unsigned = await post(app, VALID_BODY);
    const malformed = await post(app, "nope", sign("nope"));

    for (const res of [unsigned, malformed]) {
      expect(res.headers.get("X-Request-Id")).toBeString();
    }
  });
});
