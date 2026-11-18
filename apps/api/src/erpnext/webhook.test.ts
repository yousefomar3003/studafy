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

/** The school every request in this file comes from, unless a test says otherwise. */
const SITE_SCHOOL = "8f14e45f-ceea-4a67-9a2d-1c3e7b0d5a91";

/** Signed as that school's site is (QA-034): with the secret derived for it. */
const sign = (
  body: string,
  secret = createHmac("sha256", SECRET)
    .update(`erpnext-webhook-site:v1:${SITE_SCHOOL}`)
    .digest("hex"),
): string => createHmac("sha256", secret).update(body).digest("hex");

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
      "x-studafy-school": SITE_SCHOOL,
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

  test("a request naming no site is refused, even with a payload school_id (QA-034)", async () => {
    const { app } = build();
    const body = JSON.stringify({
      event_id: "evt-3",
      doctype: "Sales Invoice",
      action: "submitted",
      data: { school_id: SITE_SCHOOL, name: "SINV-002" },
    });

    const res = await app.request("/erpnext/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-erpnext-signature": sign(body) },
      body,
    });

    expect(res.status).toBe(401);
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

// QA-034: every school's ERPNext site signs with its own secret, derived from the master secret
// and the school id, and names its school in X-Studafy-School. The payload's school_id is no longer
// trusted on its own: a site that leaks its secret cannot write into another school.
describe("per-site webhook secrets (QA-034)", () => {
  const SCHOOL_A = "8f14e45f-ceea-4a67-9a2d-1c3e7b0d5a91";
  const SCHOOL_B = "1f0e3dad-9990-4af8-9b2c-46f6a5b8f0c2";
  const siteSecret = (schoolId: string) =>
    createHmac("sha256", SECRET).update(`erpnext-webhook-site:v1:${schoolId}`).digest("hex");
  const bodyFor = (schoolId: string) =>
    JSON.stringify({
      event_id: `evt-${crypto.randomUUID()}`,
      doctype: "Sales Invoice",
      action: "submitted",
      data: { school_id: schoolId, name: "SINV-9" },
    });
  const send = (
    app: ReturnType<typeof build>["app"],
    body: string,
    headers: Record<string, string>,
  ) =>
    app.request("/erpnext/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  test("site A's own secret, naming school A in the payload for school B, is refused before the database", async () => {
    const { app } = build();
    const forged = bodyFor(SCHOOL_B);
    const res = await send(app, forged, {
      "x-studafy-school": SCHOOL_A,
      "x-erpnext-signature": sign(forged, siteSecret(SCHOOL_A)),
    });
    expect(res.status).toBe(403);
  });

  test("site A's secret cannot sign for school B's header", async () => {
    const { app } = build();
    const forged = bodyFor(SCHOOL_B);
    const res = await send(app, forged, {
      "x-studafy-school": SCHOOL_B,
      "x-erpnext-signature": sign(forged, siteSecret(SCHOOL_A)),
    });
    expect(res.status).toBe(401);
  });

  test("the shared master secret alone no longer authenticates a webhook", async () => {
    const { app } = build();
    const body = bodyFor(SCHOOL_B);
    const res = await send(app, body, { "x-erpnext-signature": sign(body) });
    expect(res.status).toBe(401);
  });

  test("the rollout switch lets an unprovisioned site through with the shared secret, and only then", async () => {
    const body = bodyFor(SCHOOL_B);
    const headers = { "x-erpnext-signature": sign(body, SECRET) };
    process.env.ERPNEXT_WEBHOOK_ACCEPT_SHARED_SECRET = "true";
    try {
      // Reaches ingestion (the unusable database answers 500), as before QA-034.
      expect((await send(build().app, body, headers)).status).toBe(500);
    } finally {
      delete process.env.ERPNEXT_WEBHOOK_ACCEPT_SHARED_SECRET;
    }
    expect((await send(build().app, body, headers)).status).toBe(401);
  });

  test("a correctly signed event for its own school gets past authentication", async () => {
    const { app } = build();
    const body = bodyFor(SCHOOL_A);
    const res = await send(app, body, {
      "x-studafy-school": SCHOOL_A,
      "x-erpnext-signature": sign(body, siteSecret(SCHOOL_A)),
    });
    // The unusable database answers 500: the request was authenticated and reached ingestion.
    expect(res.status).toBe(500);
  });
});
