import {
  Environment,
  NotificationTypeV2,
  SignedDataVerifier,
} from "@apple/app-store-server-library";

import { APPLE_INC_ROOT, APPLE_ROOT_CA_G2, APPLE_ROOT_CA_G3 } from "./apple-root-certificates";
import { StoreVerificationError } from "./types";

import type { StoreEventKind, StoreSubscription } from "./types";
import type {
  JWSTransactionDecodedPayload,
  ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";

/**
 * App Store side of the in-app purchase (StoreKit 2).
 *
 * The app hands the server the transaction's JWS (`jwsRepresentation`, the in_app_purchase plugin's
 * `serverVerificationData`); App Store Server Notifications V2 post a signed payload. Both are
 * verified against Apple's published root certificates (./apple-root-certificates.ts) with Apple's own
 * library -- signature chain, bundle id, and app id in production -- before anything is believed.
 *
 * Sandbox transactions are accepted next to production ones on purpose: App Review buys with a
 * sandbox account against the production server, and refusing them fails review. The environment is
 * kept on every billing event so a sandbox purchase is never mistaken for revenue.
 */

const APPLE_ROOT_CERTIFICATES = [APPLE_ROOT_CA_G3, APPLE_ROOT_CA_G2, APPLE_INC_ROOT];

export interface AppleStoreConfig {
  bundleId: string;
  /** The app's numeric App Store id; required by Apple to verify production data. */
  appAppleId?: number;
  /** Check certificate revocation online (OCSP). On in deployments; off in tests. */
  onlineChecks?: boolean;
}

export interface AppleNotification {
  eventId: string;
  kind: StoreEventKind | null;
  subscription: StoreSubscription | null;
  signedAt: Date;
}

export interface AppleStore {
  verifyTransaction(jws: string): Promise<StoreSubscription>;
  verifyNotification(signedPayload: string): Promise<AppleNotification>;
}

/** What each V2 notification means for access. Anything unlisted changes nothing (null). */
function notificationKind(type: string | undefined): StoreEventKind | null {
  switch (type) {
    case NotificationTypeV2.SUBSCRIBED:
      return "purchased";
    case NotificationTypeV2.DID_RENEW:
      return "renewed";
    case NotificationTypeV2.DID_FAIL_TO_RENEW:
      // past_due, which keeps access, whether or not the app has a billing grace period: ending access here would make the retry's DID_RENEW arrive after a
      // terminal state and be refused. If Apple's retry gives up, it sends EXPIRED (subtype
      // BILLING_RETRY) or GRACE_PERIOD_EXPIRED, which end it.
      return "payment_failed";
    case NotificationTypeV2.EXPIRED:
    case NotificationTypeV2.GRACE_PERIOD_EXPIRED:
    case NotificationTypeV2.REFUND:
    case NotificationTypeV2.REVOKE:
      return "ended";
    default:
      // DID_CHANGE_RENEWAL_STATUS (auto-renew off) keeps access until EXPIRED; TEST, PRICE_INCREASE,
      // REFUND_DECLINED and the rest change nothing.
      return null;
  }
}

function subscriptionFrom(transaction: JWSTransactionDecodedPayload): StoreSubscription {
  if (!transaction.originalTransactionId || !transaction.transactionId || !transaction.productId) {
    throw new StoreVerificationError("Apple transaction is missing its ids or product");
  }
  const now = Date.now();
  const expires = transaction.expiresDate ?? null;
  const state = transaction.revocationDate
    ? "revoked"
    : expires !== null && expires <= now
      ? "expired"
      : "active";
  return {
    platform: "apple",
    storeRef: transaction.originalTransactionId,
    transactionId: transaction.transactionId,
    productId: transaction.productId,
    studentId: transaction.appAccountToken?.toLowerCase() ?? null,
    schoolId: null,
    state,
    periodStart: new Date(transaction.purchaseDate ?? now),
    periodEnd: expires === null ? null : new Date(expires),
    environment: String(transaction.environment ?? "unknown"),
  };
}

export function createAppleStore(config: AppleStoreConfig): AppleStore {
  // Apple will not verify production data without the app's id. Until the app has one (local
  // development, before App Store Connect), only sandbox purchases are accepted; env.ts makes
  // production deployments set it.
  const production =
    config.appAppleId === undefined
      ? null
      : new SignedDataVerifier(
          APPLE_ROOT_CERTIFICATES,
          config.onlineChecks ?? true,
          Environment.PRODUCTION,
          config.bundleId,
          config.appAppleId,
        );
  const sandbox = new SignedDataVerifier(
    APPLE_ROOT_CERTIFICATES,
    config.onlineChecks ?? true,
    Environment.SANDBOX,
    config.bundleId,
  );

  /** Production first; a sandbox payload fails it on environment and is retried against sandbox. */
  async function verifyEither<T>(run: (verifier: SignedDataVerifier) => Promise<T>): Promise<T> {
    let firstError: unknown = null;
    for (const verifier of [production, sandbox]) {
      if (!verifier) continue;
      try {
        return await run(verifier);
      } catch (error) {
        firstError ??= error;
      }
    }
    throw new StoreVerificationError(
      `Apple signature verification failed: ${(firstError as Error)?.message ?? firstError}`,
    );
  }

  return {
    async verifyTransaction(jws) {
      const transaction = await verifyEither((verifier) =>
        verifier.verifyAndDecodeTransaction(jws),
      );
      return subscriptionFrom(transaction);
    },

    async verifyNotification(signedPayload) {
      const notification: ResponseBodyV2DecodedPayload = await verifyEither((verifier) =>
        verifier.verifyAndDecodeNotification(signedPayload),
      );
      if (!notification.notificationUUID) {
        throw new StoreVerificationError("Apple notification has no notificationUUID");
      }
      const signedTransaction = notification.data?.signedTransactionInfo;
      const subscription = signedTransaction
        ? subscriptionFrom(
            await verifyEither((verifier) =>
              verifier.verifyAndDecodeTransaction(signedTransaction),
            ),
          )
        : null;
      return {
        eventId: notification.notificationUUID,
        kind: notificationKind(notification.notificationType),
        subscription,
        signedAt: new Date(notification.signedDate ?? Date.now()),
      };
    },
  };
}
