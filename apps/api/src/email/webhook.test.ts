import { createHmac, createSign, generateKeyPairSync } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../app";
import { createUnusableDatabase } from "../db/unusable";
import { createInflightTracker } from "../lifecycle";
import { createLogger } from "../logger";

import { buildSnsCanonicalMessage } from "./sns-signature";

import type { SnsEnvelope } from "./sns-signature";

/**
 * Pre-database webhook tests (deliverability R-08), mirroring the ERPNext webhook suite: every case
 * here returns before the handler touches the database, which is why createUnusableDatabase suffices
 * and this runs in the `quality` job with no Postgres. The paths that do reach the database — the
 * happy 200 (ledger insert, suppression upsert, delivery transition) and dedup — need a real
 * database; they live in tests/email/webhook.db.test.ts, which the `api-integration` job runs.
 */

const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:studafy-email-events";
// Unique to this file: sns-signature.ts caches each certificate by URL for the process's lifetime
// (a real SNS URL names one certificate), and every test file signs with its own generated key. A
// URL shared with another file would hand this one the other file's cached key when both run in
// one `bun test` process.
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-webhook-unit.pem";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" });

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  request_id: string;
}

let previousTopicArn: string | undefined;
let previousFetch: typeof globalThis.fetch;

/**
 * The webhook's default certificate fetcher uses global fetch, so the stub answers SNS's own cert
 * URL with our generated key and rejects everything else. A test that wants to observe or stub the
 * SubscribeURL fetch overrides global fetch with its own handler.
 */
function stubFetch(handler: (input: string) => Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request) =>
    handler(String(input))) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  previousTopicArn = process.env.EMAIL_EVENTS_SNS_TOPIC_ARN;
  process.env.EMAIL_EVENTS_SNS_TOPIC_ARN = TOPIC_ARN;
  previousFetch = globalThis.fetch;
  stubFetch(async (input) => {
    if (input === CERT_URL) return new Response(PUBLIC_KEY_PEM, { status: 200 });
    throw new Error(`unexpected network request in tests: ${input}`);
  });
});

afterEach(() => {
  if (previousTopicArn === undefined) {
    delete process.env.EMAIL_EVENTS_SNS_TOPIC_ARN;
  } else {
    process.env.EMAIL_EVENTS_SNS_TOPIC_ARN = previousTopicArn;
  }
  globalThis.fetch = previousFetch;
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

function notification(overrides: Partial<SnsEnvelope> = {}): SnsEnvelope {
  return {
    Type: "Notification",
    MessageId: "6b29e1a0-1b2b-4c8e-9a2e-000000000001",
    TopicArn: TOPIC_ARN,
    Message: JSON.stringify({
      eventType: "Delivery",
      mail: { messageId: "amq-123456", destination: ["parent@example.com"] },
    }),
    Timestamp: "2026-07-31T00:00:00.000Z",
    SignatureVersion: "1",
    ...overrides,
  };
}

function sign(envelope: SnsEnvelope, key: typeof privateKey = privateKey): SnsEnvelope {
  const signer = createSign("RSA-SHA1");
  signer.update(buildSnsCanonicalMessage(envelope));
  signer.end();
  return { ...envelope, Signature: signer.sign(key, "base64"), SigningCertURL: CERT_URL };
}

const post = (app: ReturnType<typeof build>["app"], body: string | object) =>
  app.request("/email/webhooks/sns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("webhook configuration", () => {
  test("answers 500 problem+json when EMAIL_EVENTS_SNS_TOPIC_ARN is unconfigured", async () => {
    delete process.env.EMAIL_EVENTS_SNS_TOPIC_ARN;
    const { app } = build();

    const res = await post(app, sign(notification()));
    const problem = (await res.json()) as Problem;

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(problem.request_id).toBeString();
  });
});

describe("signature verification", () => {
  test("rejects a body that is not a JSON object with 400", async () => {
    const { app } = build();

    const res = await post(app, "[1,2,3]");

    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("VALIDATION_FAILED");
  });

  test("rejects a signature made with the wrong key with 401", async () => {
    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { app } = build();

    const res = await post(app, sign(notification(), attacker.privateKey));
    const problem = (await res.json()) as Problem;

    expect(res.status).toBe(401);
    expect(problem.code).toBe("AUTH_TOKEN_INVALID");
    expect(problem.request_id).toBeString();
  });

  test("rejects a tampered Message with 401", async () => {
    const signed = sign(notification());
    const tampered = { ...signed, Message: JSON.stringify({ eventType: "Bounce" }) };
    const { app } = build();

    const res = await post(app, tampered);

    expect(res.status).toBe(401);
  });

  test("rejects a notification from an unexpected topic with 401", async () => {
    const signed = sign(
      notification({ TopicArn: "arn:aws:sns:us-east-1:123456789012:someone-elses-topic" }),
    );
    const { app } = build();

    const res = await post(app, signed);

    expect(res.status).toBe(401);
  });
});

describe("notification handling", () => {
  test("answers 400 when Message is not valid JSON", async () => {
    const { app } = build();

    const res = await post(app, sign(notification({ Message: "not json" })));

    expect(res.status).toBe(400);
  });

  test("answers 400 when the SES document is structurally unusable", async () => {
    const { app } = build();

    const res = await post(
      app,
      sign(notification({ Message: JSON.stringify({ eventType: "Bounce" }) })),
    );

    expect(res.status).toBe(400);
  });

  test("answers 200 for a knowingly-ignored SES event type", async () => {
    const { app } = build();

    const res = await post(
      app,
      sign(
        notification({
          Message: JSON.stringify({
            eventType: "Click",
            mail: { messageId: "amq-123456" },
          }),
        }),
      ),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("answers 500 when ingestion fails before touching the database", async () => {
    const { app } = build();

    const res = await post(app, sign(notification()));

    // The unusable database throws on the first query; errorHandlerMiddleware withholds the cause.
    expect(res.status).toBe(500);
    expect(((await res.json()) as Problem).request_id).toBeString();
  });
});

describe("subscription lifecycle", () => {
  test("auto-confirms a SubscriptionConfirmation by fetching the signed SubscribeURL", async () => {
    const subscribeUrl = "https://sns.us-east-1.amazonaws.com/confirm/xyz";
    const fetched: string[] = [];
    stubFetch(async (input) => {
      fetched.push(input);
      if (input === CERT_URL) return new Response(PUBLIC_KEY_PEM, { status: 200 });
      return new Response(null, { status: 200 });
    });

    const { app } = build();
    const res = await post(
      app,
      sign(
        notification({
          Type: "SubscriptionConfirmation",
          Message: "You have chosen to subscribe...",
          SubscribeURL: subscribeUrl,
        }),
      ),
    );

    expect(res.status).toBe(200);
    // The signing certificate may be served from the module-level cache (no fetch observed); the
    // SubscribeURL must have been fetched either way.
    expect(fetched).toContain(subscribeUrl);
  });

  test("answers 500 when confirming a subscription fails", async () => {
    stubFetch(async (input) => {
      if (input === CERT_URL) return new Response(PUBLIC_KEY_PEM, { status: 200 });
      throw new Error("network unreachable");
    });

    const { app } = build();
    const res = await post(
      app,
      sign(
        notification({
          Type: "SubscriptionConfirmation",
          Message: "You have chosen to subscribe...",
          SubscribeURL: "https://sns.us-east-1.amazonaws.com/confirm/xyz",
        }),
      ),
    );

    expect(res.status).toBe(500);
  });

  test("answers 400 when SubscriptionConfirmation has no SubscribeURL", async () => {
    const { app } = build();

    const res = await post(
      app,
      sign(
        notification({
          Type: "SubscriptionConfirmation",
          Message: "You have chosen to subscribe...",
        }),
      ),
    );

    expect(res.status).toBe(400);
  });

  test("acknowledges an UnsubscribeConfirmation with 200", async () => {
    const { app } = build();

    const res = await post(
      app,
      sign(
        notification({
          Type: "UnsubscribeConfirmation",
          Message: "You have chosen to deactivate...",
        }),
      ),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("unknown message types", () => {
  test("acknowledges an unexpected Type with 200", async () => {
    const { app } = build();

    const res = await post(app, sign(notification({ Type: "SomethingElse" })));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("Resend webhook", () => {
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
});
