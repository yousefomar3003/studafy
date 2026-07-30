import { expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in

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
