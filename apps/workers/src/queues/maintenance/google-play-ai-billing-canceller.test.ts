// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { GooglePlayAiBillingCanceller } from "./google-play-ai-billing-canceller";

const PACKAGE = "com.studafy.studafy_mobile";
const BASE = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/purchases`;

function canceller(state: string, productId: string | null = "studafy_ai_monthly") {
  const calls: { method: string; url: string }[] = [];
  const instance = new GooglePlayAiBillingCanceller({
    packageName: PACKAGE,
    serviceAccountJson: "{}",
    request: async (method, url) => {
      calls.push({ method, url });
      return method === "GET"
        ? { subscriptionState: state, lineItems: productId ? [{ productId }] : [] }
        : {};
    },
  });
  return { instance, calls };
}

describe("GooglePlayAiBillingCanceller", () => {
  test("reads the product back from Play, then cancels by it", async () => {
    const { instance, calls } = canceller("SUBSCRIPTION_STATE_ACTIVE");

    expect(await instance.cancelGooglePlaySubscription("tok/en")).toBe("canceled");
    expect(calls).toEqual([
      { method: "GET", url: `${BASE}/subscriptionsv2/tokens/tok%2Fen` },
      { method: "POST", url: `${BASE}/subscriptions/studafy_ai_monthly/tokens/tok%2Fen:cancel` },
    ]);
  });

  test("does not call cancel for a subscription that will not renew anyway", async () => {
    for (const state of ["SUBSCRIPTION_STATE_CANCELED", "SUBSCRIPTION_STATE_EXPIRED"]) {
      const { instance, calls } = canceller(state);
      expect(await instance.cancelGooglePlaySubscription("tok")).toBe("not_renewing");
      expect(calls.map((call) => call.method)).toEqual(["GET"]);
    }
  });

  test("refuses a subscription without a product", async () => {
    const { instance } = canceller("SUBSCRIPTION_STATE_ACTIVE", null);
    await expect(instance.cancelGooglePlaySubscription("tok")).rejects.toThrow("no line item");
  });
});
