import { createSign, generateKeyPairSync } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app";
import { buildSnsCanonicalMessage } from "../../src/email/sns-signature";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { createSchool, createTestDatabase, integrationEnabled, migrateDatabase } from "../harness";

import type { SnsEnvelope } from "../../src/email/sns-signature";
import type { AppEnv } from "../../src/middleware";
import type { TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Sql } from "postgres";

/**
 * Database-backed SES → SNS webhook tests (deliverability R-08).
 *
 * The pre-DB suite (src/email/webhook.test.ts) covers everything that returns before the handler
 * touches Postgres. This suite exercises the three mutations the happy path makes — the ledger insert
 * into app.email_events, the suppression upsert, and the delivery transition — plus SNS at-least-once
 * redelivery against the real unique constraint. It creates a disposable database, migrates it from
 * the repository migrations, and drives the real app through its real route, exactly like the
 * ST-072 revocation suite. Gated on TEST_DATABASE_URL; runs in the `api-integration` job.
 */

const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:studafy-email-events";
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" });

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | undefined;
let sql: Sql;
let app: OpenAPIHono<AppEnv>;
let schoolA: { id: string; slug: string };
let schoolB: { id: string; slug: string };

let previousTopicArn: string | undefined;
let previousFetch: typeof globalThis.fetch | undefined;
let outboxEventCounter = 0;

/**
 * The webhook's default certificate fetcher uses global fetch; the stub answers SNS's own cert URL
 * with our generated key and rejects everything else. This suite never follows a SubscribeURL, so the
 * cert is the only network request the webhook makes.
 */
function stubFetch(handler: (input: string) => Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request) =>
    handler(String(input))) as unknown as typeof globalThis.fetch;
}

beforeAll(async () => {
  if (!integrationEnabled) return;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;

  schoolA = await createSchool(sql);
  schoolB = await createSchool(sql);

  previousTopicArn = process.env.EMAIL_EVENTS_SNS_TOPIC_ARN;
  process.env.EMAIL_EVENTS_SNS_TOPIC_ARN = TOPIC_ARN;
  previousFetch = globalThis.fetch;
  stubFetch(async (input) => {
    if (input === CERT_URL) return new Response(PUBLIC_KEY_PEM, { status: 200 });
    throw new Error(`unexpected network request in tests: ${input}`);
  });

  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    redis: null,
    database: sql,
  });
}, 60_000);

afterAll(async () => {
  if (previousTopicArn === undefined) {
    delete process.env.EMAIL_EVENTS_SNS_TOPIC_ARN;
  } else {
    process.env.EMAIL_EVENTS_SNS_TOPIC_ARN = previousTopicArn;
  }
  if (previousFetch !== undefined) globalThis.fetch = previousFetch;
  await database?.cleanup();
});

/** A landed-or-unlanded delivery row exactly as the dispatcher would leave one. */
async function seedDelivery(params: {
  schoolId: string;
  recipient: string;
  messageId: string | null;
  status?: "sent" | "claimed" | "bounced" | "complained";
}): Promise<void> {
  const status = params.status ?? "sent";
  outboxEventCounter += 1;
  await sql`
    INSERT INTO app.email_deliveries (school_id, outbox_event_id, recipient, template, status, message_id)
    VALUES (${params.schoolId}, ${outboxEventCounter}, ${params.recipient}, 'alert', ${status}, ${params.messageId})
  `;
}

/** The `Message` SES publishes for a bounce — including SES's own `bouncedRecipients` key. */
function sesBounce(messageId: string, recipients: string[], bounceType = "Permanent"): string {
  return JSON.stringify({
    eventType: "Bounce",
    mail: { messageId, destination: recipients },
    bounce: {
      bounceType,
      bouncedRecipients: recipients.map((emailAddress) => ({ emailAddress })),
    },
  });
}

function sesComplaint(messageId: string, recipients: string[]): string {
  return JSON.stringify({
    eventType: "Complaint",
    mail: { messageId, destination: recipients },
    complaint: { complaintRecipients: recipients.map((emailAddress) => ({ emailAddress })) },
  });
}

function sesDelivery(messageId: string, recipients: string[]): string {
  return JSON.stringify({
    eventType: "Delivery",
    mail: { messageId, destination: recipients },
    delivery: { timestamp: "2026-07-31T00:00:00.000Z", recipients },
  });
}

function notification(message: string, messageId = crypto.randomUUID()): SnsEnvelope {
  return {
    Type: "Notification",
    MessageId: messageId,
    TopicArn: TOPIC_ARN,
    Message: message,
    Timestamp: "2026-07-31T00:00:00.000Z",
    SignatureVersion: "1",
  };
}

function sign(envelope: SnsEnvelope): SnsEnvelope {
  const signer = createSign("RSA-SHA1");
  signer.update(buildSnsCanonicalMessage(envelope));
  signer.end();
  return { ...envelope, Signature: signer.sign(privateKey, "base64"), SigningCertURL: CERT_URL };
}

const post = (envelope: object) =>
  app.request("/email/webhooks/sns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });

describe("bounce handling", () => {
  integrationTest(
    "records a permanent bounce, suppresses every bounced recipient (normalized), and transitions the deliveries",
    async () => {
      const messageId = "amq-bounce-permanent-1";
      // Mixed case and surrounding whitespace prove the suppression list stores the normalized address.
      const bounced = ["Parent1@Example.com ", "second-parent@example.com"];
      for (const recipient of bounced) {
        await seedDelivery({
          schoolId: schoolA.id,
          recipient: recipient.trim().toLowerCase(),
          messageId,
        });
      }

      const res = await post(sign(notification(sesBounce(messageId, bounced))));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const [ledger] = await sql<{ event_type: string }[]>`
        SELECT event_type FROM app.email_events WHERE message_id = ${messageId}
      `;
      expect(ledger?.event_type).toBe("bounce");

      // The payload is stored as a JSON object, not as a JSON-encoded string scalar — binding a
      // pre-stringified string makes postgres.js serialize it again (double-encoded) and the
      // ck_email_events_payload check would reject it.
      const [payloadType] = await sql<{ payload_type: string }[]>`
        SELECT jsonb_typeof(payload)::text AS payload_type
        FROM app.email_events WHERE message_id = ${messageId}
      `;
      expect(payloadType?.payload_type).toBe("object");

      const suppressed = await sql<{ reason: string }[]>`
        SELECT reason FROM app.email_suppressions
        WHERE address IN ('parent1@example.com', 'second-parent@example.com')
        ORDER BY address
      `;
      expect(suppressed).toHaveLength(2);
      for (const row of suppressed) expect(row.reason).toBe("bounce");

      const deliveries = await sql<{ status: string }[]>`
        SELECT status FROM app.email_deliveries WHERE message_id = ${messageId} ORDER BY recipient
      `;
      expect(deliveries).toHaveLength(2);
      for (const row of deliveries) expect(row.status).toBe("bounced");
    },
  );

  integrationTest("records a transient bounce without suppressing the address", async () => {
    const messageId = "amq-bounce-transient-1";
    const recipient = "parent2@example.com";
    await seedDelivery({ schoolId: schoolA.id, recipient, messageId });

    const res = await post(sign(notification(sesBounce(messageId, [recipient], "Transient"))));

    expect(res.status).toBe(200);

    const [ledger] = await sql<{ event_type: string }[]>`
      SELECT event_type FROM app.email_events WHERE message_id = ${messageId}
    `;
    expect(ledger?.event_type).toBe("bounce");

    const [suppression] = await sql`
      SELECT reason FROM app.email_suppressions WHERE address = ${recipient}
    `;
    expect(suppression).toBeUndefined();

    const [delivery] = await sql<{ status: string }[]>`
      SELECT status FROM app.email_deliveries WHERE message_id = ${messageId}
    `;
    expect(delivery?.status).toBe("bounced");
  });
});

describe("complaint handling", () => {
  integrationTest(
    "suppresses complained addresses and transitions the delivery to complained",
    async () => {
      const messageId = "amq-complaint-1";
      const recipient = "parent3@example.com";
      await seedDelivery({ schoolId: schoolA.id, recipient, messageId });

      const res = await post(sign(notification(sesComplaint(messageId, [recipient]))));

      expect(res.status).toBe(200);

      const [ledger] = await sql<{ event_type: string }[]>`
      SELECT event_type FROM app.email_events WHERE message_id = ${messageId}
    `;
      expect(ledger?.event_type).toBe("complaint");

      const [suppression] = await sql<{ reason: string }[]>`
      SELECT reason FROM app.email_suppressions WHERE address = ${recipient}
    `;
      expect(suppression?.reason).toBe("complaint");

      const [delivery] = await sql<{ status: string }[]>`
      SELECT status FROM app.email_deliveries WHERE message_id = ${messageId}
    `;
      expect(delivery?.status).toBe("complained");
    },
  );
});

describe("delivery handling", () => {
  integrationTest("records a delivery event without suppressing or transitioning", async () => {
    const messageId = "amq-delivery-1";
    const recipient = "parent4@example.com";
    await seedDelivery({ schoolId: schoolA.id, recipient, messageId });

    const res = await post(sign(notification(sesDelivery(messageId, [recipient]))));

    expect(res.status).toBe(200);

    const [ledger] = await sql<{ event_type: string }[]>`
      SELECT event_type FROM app.email_events WHERE message_id = ${messageId}
    `;
    expect(ledger?.event_type).toBe("delivery");

    const [delivery] = await sql<{ status: string }[]>`
      SELECT status FROM app.email_deliveries WHERE message_id = ${messageId}
    `;
    expect(delivery?.status).toBe("sent");
  });
});

describe("deduplication", () => {
  integrationTest("absorbs an SNS redelivery without re-recording or re-processing", async () => {
    const messageId = "amq-dedup-1";
    const recipient = "parent5@example.com";
    await seedDelivery({ schoolId: schoolA.id, recipient, messageId });

    const signed = sign(notification(sesBounce(messageId, [recipient])));
    const first = await post(signed);
    const redelivery = await post(signed);

    expect(first.status).toBe(200);
    expect(redelivery.status).toBe(200);

    const [count] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.email_events WHERE message_id = ${messageId}
    `;
    expect(count?.count).toBe(1);

    const [suppressions] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.email_suppressions WHERE address = ${recipient}
    `;
    expect(suppressions?.count).toBe(1);

    const [delivery] = await sql<{ status: string }[]>`
      SELECT status FROM app.email_deliveries WHERE message_id = ${messageId}
    `;
    expect(delivery?.status).toBe("bounced");
  });
});

describe("delivery transitions", () => {
  integrationTest(
    "transitions only landed 'sent' rows and never walks a terminal row backwards",
    async () => {
      const messageId = "amq-partial-1";
      const recipient = "parent6@example.com";
      await seedDelivery({ schoolId: schoolA.id, recipient, messageId, status: "sent" });
      await seedDelivery({
        schoolId: schoolA.id,
        recipient: "already-bounced@example.com",
        messageId,
        status: "bounced",
      });
      await seedDelivery({
        schoolId: schoolA.id,
        recipient: "not-yet-sent@example.com",
        messageId: null,
        status: "claimed",
      });

      const res = await post(sign(notification(sesBounce(messageId, [recipient]))));

      expect(res.status).toBe(200);

      const rows = [
        ...(await sql<{ recipient: string; status: string }[]>`
      SELECT recipient, status FROM app.email_deliveries
      WHERE school_id = ${schoolA.id}
        AND recipient = ANY(ARRAY['parent6@example.com', 'already-bounced@example.com', 'not-yet-sent@example.com'])
      ORDER BY recipient
    `),
      ];
      expect(rows).toEqual([
        { recipient: "already-bounced@example.com", status: "bounced" },
        { recipient: "not-yet-sent@example.com", status: "claimed" },
        { recipient: "parent6@example.com", status: "bounced" },
      ]);
    },
  );

  integrationTest("transitions deliveries in every school holding the message", async () => {
    const messageId = "amq-cross-tenant-1";
    const recipient = "cross@example.com";
    await seedDelivery({ schoolId: schoolA.id, recipient, messageId });
    await seedDelivery({ schoolId: schoolB.id, recipient, messageId });

    const res = await post(sign(notification(sesBounce(messageId, [recipient]))));

    expect(res.status).toBe(200);

    const rows = await sql<{ school_id: string; status: string }[]>`
      SELECT school_id, status FROM app.email_deliveries WHERE message_id = ${messageId} ORDER BY school_id
    `;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.status).toBe("bounced");
  });
});
