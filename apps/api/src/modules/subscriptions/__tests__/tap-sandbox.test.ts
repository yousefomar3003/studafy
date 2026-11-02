/**
 * Live smoke test against Tap's sandbox (ST-298). Opt-in: runs only when TAP_TEST_SECRET_KEY holds a
 * `sk_test_` key, and refuses a live key outright. Not part of CI, because it needs network access
 * and a merchant account.
 *
 * Proves the half of "a test-mode charge succeeds in JOD" that an API call can prove: Tap accepts
 * the customer and the JOD charge exactly as TapAdapter builds them, and hands back a hosted page.
 * Paying on that page with a Tap test card is the other half, and is a manual step in
 * docs/runbooks/tap-payments-setup.md -- a card number typed into a test here would be exactly the
 * card data this integration exists to keep off Studafy's servers.
 *
 *   TAP_TEST_SECRET_KEY=sk_test_... bun test tap-sandbox
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { TapAdapter } from "../tap/adapter";

const secretKey = process.env.TAP_TEST_SECRET_KEY ?? "";
const sandboxTest = test.skipIf(!secretKey.startsWith("sk_test_"));

describe("Tap sandbox", () => {
  sandboxTest(
    "creates a customer and a hosted JOD charge in test mode",
    async () => {
      const adapter = new TapAdapter({
        secretKey,
        webhookUrl:
          process.env.TAP_WEBHOOK_URL ?? "https://example.com/api/subscriptions/webhook/tap",
      });

      const { providerCustomerId } = await adapter.createCustomer({
        name: "Studafy Sandbox School",
        email: "sandbox@studafy.test",
        metadata: { school_id: "00000000-0000-4000-8000-000000000000" },
      });
      expect(providerCustomerId).toStartWith("cus_");

      const session = await adapter.createCheckoutSession({
        customerId: providerCustomerId,
        priceId: "sandbox-price",
        amountMinor: 15_500,
        currency: "JOD",
        successUrl: "https://example.com/billing/return",
        cancelUrl: "https://example.com/billing",
        metadata: { school_id: "00000000-0000-4000-8000-000000000000" },
      });

      expect(session.sessionId).toStartWith("chg_");
      expect(session.url).toStartWith("https://");
    },
    30_000,
  );
});
