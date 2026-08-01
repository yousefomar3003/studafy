/**
 * The signature-verification acceptance criterion, through the real HTTP stack (ST-132).
 *
 * "Signature verification failure returns 400 and fires an alert." Both halves need the whole
 * middleware chain, not just the handler:
 *
 *   - The 400 has to *reach* the caller. `/api/subscriptions/webhook/stripe` sits under `/api/*`, so
 *     before ST-132 the CSRF middleware rejected every Stripe delivery with 403 `missing_token` —
 *     Stripe sends no session cookie and no Authorization header, so neither the exemption list nor
 *     the Bearer exemption covered it. A test that called the handler directly would have passed
 *     against an endpoint that was unreachable in production.
 *   - The alert rides the ST-082 `SecurityEventSink`, which `createApp` constructs and threads into
 *     the route.
 *
 * So these go through `app.request()` with no auth at all, exactly as Stripe would.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { integrationEnabled } from "../../../../tests/harness";
import { createApp } from "../../../app";
import { createInflightTracker } from "../../../lifecycle";
import { createLogger } from "../../../logger";
import { KeyStore } from "../../auth";

import {
  createBillingDatabase,
  createBillingFixture,
  createProviderStub,
  encodeEvent,
  resetBillingEvents,
} from "./webhook-fixture";

import type { ProviderStub } from "./webhook-fixture";
import type { TestDatabase } from "../../../../tests/harness";
import type { SecurityEvent, SecurityEventSink } from "../../../lib/security/securityEventSink";

const integrationTest = test.skipIf(!integrationEnabled);

const WEBHOOK_PATH = "/api/subscriptions/webhook/stripe";

/** A sink that keeps what it was handed. The async batching in the real one is not under test here. */
function createRecordingSink(): SecurityEventSink & { events: SecurityEvent[] } {
  const events: SecurityEvent[] = [];
  return {
    events,
    record: (event) => events.push(event),
    flush: async () => undefined,
    close: async () => undefined,
    droppedCount: () => 0,
  };
}

interface Harness {
  request: (init: RequestInit) => Promise<Response>;
  sink: ReturnType<typeof createRecordingSink>;
  provider: ProviderStub;
  destroy: () => Promise<void>;
}

/**
 * A real app over a real database.
 *
 * The database is not incidental: `createApp` registers the subscription routes only when one is
 * configured (app.ts), so without it the endpoint 404s and none of these assertions would mean what
 * they say. Nothing here reaches a transaction — every case is either rejected at verification or
 * accepted and immediately parked — but the route has to exist to reject anything.
 */
let database: TestDatabase | null = null;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createBillingDatabase();
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
  database = null;
});

async function createHarness(): Promise<Harness> {
  const fixture = await createBillingFixture(database!);
  const keyStore = new KeyStore(60_000);
  await keyStore.init();

  const sink = createRecordingSink();
  const provider = createProviderStub();

  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    redis: null,
    database: fixture.db.sql,
    keyStore,
    jwtIssuer: "studafy-test",
    jwtAudience: "studafy-api-test",
    docsEnabled: false,
    stripeProvider: provider,
    securityEventSink: sink,
  });

  return {
    request: async (init) => app.request(WEBHOOK_PATH, { method: "POST", ...init }),
    sink,
    provider,
    destroy: async () => {
      keyStore.destroy();
      await resetBillingEvents(fixture.db);
    },
  };
}

const body = () =>
  encodeEvent({ id: "evt_sig", type: "invoice.paid", created: 1_700_000_100, data: {} });

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.destroy();
  harness = null;
});

describe("stripe webhook signature verification", () => {
  integrationTest("a missing signature header returns 400 problem+json and alerts", async () => {
    harness = await createHarness();

    const res = await harness.request({ body: body() });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as { code?: string };
    expect(problem.code).toBe("STRIPE_WEBHOOK_INVALID");

    expect(harness.sink.events).toHaveLength(1);
    expect(harness.sink.events[0]).toMatchObject({
      eventType: "stripe_webhook_signature_invalid",
      path: WEBHOOK_PATH,
      method: "POST",
    });
  });

  integrationTest("an invalid signature returns 400 and alerts", async () => {
    harness = await createHarness();
    harness.provider.shouldReject = true;

    const res = await harness.request({
      body: body(),
      headers: { "stripe-signature": "t=1,v1=forged" },
    });

    expect(res.status).toBe(400);
    const problem = (await res.json()) as { code?: string };
    expect(problem.code).toBe("STRIPE_WEBHOOK_INVALID");
    expect(harness.sink.events[0]?.eventType).toBe("stripe_webhook_signature_invalid");
  });

  // The regression guard on the CSRF exemption. Without it this request is 403 missing_token and
  // never reaches the processor — which is what production did before ST-132. The body names no
  // customer, so the processor parks it and answers 200; a 200 here is therefore precisely the
  // statement "the request got all the way through the middleware chain to the handler".
  integrationTest(
    "a valid signature reaches the handler rather than being rejected by CSRF",
    async () => {
      harness = await createHarness();

      const res = await harness.request({
        body: body(),
        headers: { "stripe-signature": "t=1,v1=stub" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, outcome: "parked" });
      expect(harness.sink.events).toHaveLength(0);
    },
  );

  integrationTest("no alert is fired for a request that verifies", async () => {
    harness = await createHarness();

    await harness.request({ body: body(), headers: { "stripe-signature": "t=1,v1=stub" } });

    expect(harness.sink.events.filter((e) => e.eventType.startsWith("stripe_"))).toHaveLength(0);
  });
});
