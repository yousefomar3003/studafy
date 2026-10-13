import { GoogleAuth } from "google-auth-library";

import { StoreVerificationError } from "./types";

import type { StoreEventKind, StoreSubscription, StoreSubscriptionState } from "./types";

/**
 * Google Play side of the in-app purchase (Play Billing).
 *
 * The app hands the server the purchase token; Real-time Developer Notifications (RTDN) arrive
 * through a Cloud Pub/Sub push carrying only a token and an event code. Neither is trusted on its
 * own: the subscription's state is always read back from the Play Developer API
 * (purchases.subscriptionsv2.get) with the service account's credentials, and a new purchase is
 * acknowledged there -- Play refunds any purchase left unacknowledged for three days.
 */

const ANDROID_PUBLISHER =
  "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

export interface GooglePlayConfig {
  packageName: string;
  /** The Play Console service account's JSON key. */
  serviceAccountJson: string;
  /** Injected in tests: performs an authenticated request and returns the parsed JSON body. */
  request?: (method: "GET" | "POST", url: string) => Promise<unknown>;
}

export interface GoogleNotification {
  eventId: string;
  kind: StoreEventKind | null;
  purchaseToken: string | null;
  sentAt: Date;
}

export interface GooglePlayStore {
  getSubscription(purchaseToken: string): Promise<StoreSubscription>;
  acknowledge(productId: string, purchaseToken: string): Promise<void>;
  /** Decode a Pub/Sub push body. Throws on anything that is not an RTDN for this package. */
  parseNotification(body: unknown): GoogleNotification;
}

interface SubscriptionPurchaseV2 {
  subscriptionState?: string;
  startTime?: string;
  latestOrderId?: string;
  acknowledgementState?: string;
  testPurchase?: unknown;
  lineItems?: { productId?: string; expiryTime?: string }[];
  externalAccountIdentifiers?: {
    obfuscatedExternalAccountId?: string;
    obfuscatedExternalProfileId?: string;
  };
}

const STATES: Readonly<Record<string, StoreSubscriptionState>> = {
  SUBSCRIPTION_STATE_ACTIVE: "active",
  // Cancelled by the user but paid to the end of the period: still active until it expires.
  SUBSCRIPTION_STATE_CANCELED: "active",
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "grace",
  SUBSCRIPTION_STATE_ON_HOLD: "billing_retry",
  SUBSCRIPTION_STATE_PAUSED: "billing_retry",
  SUBSCRIPTION_STATE_EXPIRED: "expired",
  SUBSCRIPTION_STATE_PENDING: "expired",
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "expired",
};

/** RTDN subscriptionNotification.notificationType -> lifecycle moment; unlisted codes change nothing. */
const NOTIFICATION_KINDS: Readonly<Record<number, StoreEventKind>> = {
  1: "renewed", // RECOVERED
  2: "renewed", // RENEWED
  4: "purchased", // PURCHASED
  5: "payment_failed", // ON_HOLD
  6: "payment_failed", // IN_GRACE_PERIOD
  7: "renewed", // RESTARTED
  12: "ended", // REVOKED
  13: "ended", // EXPIRED
};

export function createGooglePlayStore(config: GooglePlayConfig): GooglePlayStore {
  const request =
    config.request ??
    (() => {
      const auth = new GoogleAuth({
        credentials: JSON.parse(config.serviceAccountJson) as Record<string, string>,
        scopes: ["https://www.googleapis.com/auth/androidpublisher"],
      });
      return async (method: "GET" | "POST", url: string) => {
        const client = await auth.getClient();
        const response = await client.request({ method, url });
        return response.data;
      };
    })();

  const base = `${ANDROID_PUBLISHER}/${encodeURIComponent(config.packageName)}/purchases/subscriptions`;

  return {
    async getSubscription(purchaseToken) {
      let purchase: SubscriptionPurchaseV2;
      try {
        purchase = (await request(
          "GET",
          `${ANDROID_PUBLISHER}/${encodeURIComponent(config.packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
        )) as SubscriptionPurchaseV2;
      } catch (error) {
        throw new StoreVerificationError(
          `Google Play did not recognize the purchase: ${(error as Error).message ?? error}`,
        );
      }
      const line = purchase.lineItems?.[0];
      if (!line?.productId) {
        throw new StoreVerificationError("Google Play subscription has no line item");
      }
      const ids = purchase.externalAccountIdentifiers ?? {};
      return {
        platform: "google",
        storeRef: purchaseToken,
        transactionId: purchase.latestOrderId ?? purchaseToken,
        productId: line.productId,
        studentId: ids.obfuscatedExternalAccountId?.toLowerCase() ?? null,
        schoolId: ids.obfuscatedExternalProfileId?.toLowerCase() ?? null,
        state: STATES[purchase.subscriptionState ?? ""] ?? "expired",
        periodStart: new Date(purchase.startTime ?? Date.now()),
        periodEnd: line.expiryTime ? new Date(line.expiryTime) : null,
        environment: purchase.testPurchase ? "test" : "production",
      };
    },

    async acknowledge(productId, purchaseToken) {
      await request(
        "POST",
        `${base}/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
      );
    },

    parseNotification(body) {
      const message = (
        body as { message?: { data?: string; messageId?: string; publishTime?: string } }
      )?.message;
      if (!message?.data || !message.messageId) {
        throw new StoreVerificationError("Not a Pub/Sub push message");
      }
      const decoded = JSON.parse(Buffer.from(message.data, "base64").toString("utf8")) as {
        packageName?: string;
        eventTimeMillis?: string;
        subscriptionNotification?: { notificationType?: number; purchaseToken?: string };
      };
      if (decoded.packageName !== config.packageName) {
        throw new StoreVerificationError("Notification is for another package");
      }
      const notification = decoded.subscriptionNotification;
      return {
        eventId: message.messageId,
        kind: notification?.notificationType
          ? (NOTIFICATION_KINDS[notification.notificationType] ?? null)
          : null,
        purchaseToken: notification?.purchaseToken ?? null,
        sentAt: new Date(Number(decoded.eventTimeMillis ?? Date.now())),
      };
    },
  };
}
