/**
 * In-app purchase of the per-student AI add-on through the App Store and Google Play.
 *
 * The stores sell it; Studafy only learns about it and turns the student's AI on and off. A store
 * subscription is read into a {@link StoreSubscription} snapshot (apple.ts verifies Apple's signed
 * JWS, google.ts asks the Play Developer API), translated into the shared billing event vocabulary
 * (events.ts) and applied by `@studafy/billing` exactly like a Stripe or Tap event -- so renewals,
 * grace, cancellation and the entitlement cache behave the same whichever way the add-on was bought.
 */

export type StorePlatform = "apple" | "google";

/** What the store says about one subscription right now. */
export type StoreSubscriptionState =
  /** Paid and current. */
  | "active"
  /** Renewal failed; the store keeps access on while it retries (Apple grace, Play grace period). */
  | "grace"
  /** Renewal failed and access is off while the store retries (Apple billing retry, Play on hold). */
  | "billing_retry"
  /** Ended: lapsed, cancelled and run out, or never completed. */
  | "expired"
  /** Refunded or revoked by the store: ends access immediately. */
  | "revoked";

export interface StoreSubscription {
  platform: StorePlatform;
  /**
   * The store's stable id for the subscription across renewals -- Apple's originalTransactionId,
   * Google's purchase token. What later notifications are attributed by.
   */
  storeRef: string;
  /** This particular transaction / order, for idempotency of the purchase report. */
  transactionId: string;
  productId: string;
  /**
   * The Studafy student the app bought it for, as the app stamped it on the purchase: Apple's
   * appAccountToken, Google's obfuscatedExternalAccountId. Null when absent.
   */
  studentId: string | null;
  /** Google only: obfuscatedExternalProfileId, the school. Null on Apple. */
  schoolId: string | null;
  state: StoreSubscriptionState;
  /** Start of the period this purchase or renewal pays for. */
  periodStart: Date;
  /** End of that period; null when the store reports none. */
  periodEnd: Date | null;
  /** Apple: Production | Sandbox | Xcode. Google: production | test. */
  environment: string;
}

/** The lifecycle moment a store notification reports, in the terms of the billing state machine. */
export type StoreEventKind = "purchased" | "renewed" | "payment_failed" | "ended";

export class StoreVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreVerificationError";
  }
}
