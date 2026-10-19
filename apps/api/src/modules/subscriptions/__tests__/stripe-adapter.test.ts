import { expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import Stripe from "stripe";

import { StripeAdapter } from "../stripe/adapter";

test("StripeAdapter constructor throws on empty secret key", () => {
  expect(() => new StripeAdapter({ secretKey: "", webhookSecret: "" })).toThrow();
});

test("StripeAdapter rejects live key in dev mode check", () => {
  const key = "sk_live_fake_key_for_test";
  expect(() => new StripeAdapter({ secretKey: key, webhookSecret: "whsec_test" })).not.toThrow();
});

test("StripeAdapter webhook parse fails with invalid signature", async () => {
  const adapter = new StripeAdapter({
    secretKey: "sk_test_placeholder",
    webhookSecret: "whsec_test",
  });

  const payload = Buffer.from(JSON.stringify({ type: "test", data: { id: "evt_1" } }));
  await expect(adapter.parseWebhook(payload, "bad_signature")).rejects.toThrow();
});

// Regression: under Bun the SDK verifies with Web Crypto, which has no synchronous form, so the
// synchronous constructEvent() rejected every webhook -- valid ones included -- and the test above
// could not tell. A payload signed the way Stripe signs it must be accepted.
test("StripeAdapter accepts a correctly signed webhook", async () => {
  const secret = "whsec_test_secret";
  const adapter = new StripeAdapter({ secretKey: "sk_test_placeholder", webhookSecret: secret });
  const body = JSON.stringify({
    id: "evt_test_1",
    object: "event",
    type: "checkout.session.completed",
    created: 1_790_000_000,
    livemode: false,
    data: { object: { id: "cs_test_1", object: "checkout.session" } },
  });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload: body, secret });

  const event = await adapter.parseWebhook(Buffer.from(body), signature);

  expect(event.id).toBe("evt_test_1");
  expect(event.type).toBe("checkout.session.completed");
  expect(event.effectiveAt).toEqual(new Date(1_790_000_000 * 1000));
});
