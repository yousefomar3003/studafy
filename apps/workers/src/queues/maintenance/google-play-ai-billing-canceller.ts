/**
 * Google Play side of the account-deletion sweep (000143): turns off renewal of an AI add-on bought
 * through Google Play (purchases.subscriptions.cancel). The student keeps access to the end of the
 * period paid for; nothing is refunded. Same calls as apps/api's store/google.ts `cancel()`, which
 * licensing uses when a school seat covers a Play subscriber: the product id is read back from Play
 * (purchases.subscriptionsv2.get), because the cancel endpoint is addressed by it.
 *
 * There is no App Store counterpart: Apple offers developers no way to cancel a subscription, so
 * the delete screens tell the person to cancel it in the store themselves.
 */

import { GoogleAuth } from "google-auth-library";

import type { GooglePlayBillingCanceller } from "./account-deletion-sweep";

const ANDROID_PUBLISHER =
  "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

/** The sweep holds the account's transaction open around this call, so it must not hang. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Play states in which the subscription will not renew anyway: nothing to cancel. */
const NOT_RENEWING = new Set([
  "SUBSCRIPTION_STATE_CANCELED",
  "SUBSCRIPTION_STATE_EXPIRED",
  "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED",
]);

export type GooglePlayRequest = (method: "GET" | "POST", url: string) => Promise<unknown>;

export interface GooglePlayCancellerConfig {
  packageName: string;
  /** The Play Console service account's JSON key. */
  serviceAccountJson: string;
  /** Injected in tests: performs an authenticated request and returns the parsed JSON body. */
  request?: GooglePlayRequest;
}

export class GooglePlayAiBillingCanceller implements GooglePlayBillingCanceller {
  private readonly request: GooglePlayRequest;
  private readonly base: string;

  constructor(config: GooglePlayCancellerConfig) {
    this.base = `${ANDROID_PUBLISHER}/${encodeURIComponent(config.packageName)}/purchases`;
    this.request = config.request ?? authenticatedRequest(config.serviceAccountJson);
  }

  async cancelGooglePlaySubscription(purchaseToken: string): Promise<"canceled" | "not_renewing"> {
    const token = encodeURIComponent(purchaseToken);
    const purchase = (await this.request(
      "GET",
      `${this.base}/subscriptionsv2/tokens/${token}`,
    )) as {
      subscriptionState?: string;
      lineItems?: { productId?: string }[];
    };
    if (NOT_RENEWING.has(purchase.subscriptionState ?? "")) return "not_renewing";
    const productId = purchase.lineItems?.[0]?.productId;
    if (!productId) throw new Error("Google Play subscription has no line item");
    await this.request(
      "POST",
      `${this.base}/subscriptions/${encodeURIComponent(productId)}/tokens/${token}:cancel`,
    );
    return "canceled";
  }
}

function authenticatedRequest(serviceAccountJson: string): GooglePlayRequest {
  const auth = new GoogleAuth({
    credentials: JSON.parse(serviceAccountJson) as Record<string, string>,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  return async (method, url) => {
    const client = await auth.getClient();
    const response = await client.request({ method, url, timeout: REQUEST_TIMEOUT_MS });
    return response.data;
  };
}
