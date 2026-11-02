import { processBillingEvent } from "@studafy/billing";
import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withSystemTx, withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { getLocalizedMessage } from "../../../middleware/locale";
import { publishEntitlementChange } from "../entitlements/entitlement-change-publisher";

import { storeBillingEvent } from "./events";
import { StoreVerificationError } from "./types";

import type { AppleStore } from "./apple";
import type { StoreBillingEvent } from "./events";
import type { GooglePlayStore } from "./google";
import type { StoreEventKind, StorePlatform, StoreSubscription } from "./types";
import type { Database, DatabasePools } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { SupportedLocale } from "../../../middleware/locale";
import type { BillingAuditWriter } from "@studafy/billing";
import type { TransactionSql } from "postgres";

/**
 * Turning a store purchase on and off (see ./types.ts for the overall design).
 *
 * - {@link registerStorePurchase}: the student's app reports a completed purchase. This is the one
 *   moment the server knows both the store's reference and the Studafy school and student it is
 *   for, so it is also where that link is recorded (as the purchase's billing event).
 * - {@link handleAppleNotification} / {@link handleGooglePlayNotification}: renewals, failures,
 *   expiry and refunds the stores report later, unauthenticated. They are attributed to the
 *   school and student through the purchase's billing event (`store_ref`), so a notification can
 *   only ever move the subscription of the student who registered it.
 */

export interface StoreBilling {
  /** The AI add-on's product id, the same in App Store Connect and the Play Console. */
  productId: string;
  apple: AppleStore | null;
  google: GooglePlayStore | null;
  /** Shared secret in the Pub/Sub push endpoint's URL (`?token=`), authenticating Google's pushes. */
  googleNotificationToken: string | null;
}

export interface StorePurchaseResult {
  active: boolean;
  expiresAt: string | null;
}

const auditWriter: BillingAuditWriter = (tx, entry) => emitAuditLog(tx, entry);

function storeError(
  status: 400 | 403 | 409 | 503,
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  locale: SupportedLocale,
) {
  return new CodedHttpException(status, code, getLocalizedMessage(code, locale));
}

/** The school and student a store subscription was registered for, from its first billing event. */
async function findClaim(
  tx: TransactionSql,
  platform: StorePlatform,
  storeRef: string,
): Promise<{ schoolId: string; studentId: string } | null> {
  const [row] = await tx<{ school_id: string | null; student_id: string | null }[]>`
    SELECT payload -> 'metadata' ->> 'school_id' AS school_id,
           payload -> 'metadata' ->> 'student_id' AS student_id
    FROM app.billing_events
    WHERE provider = ${platform}
      AND payload ->> 'store_ref' = ${storeRef}
      AND status = 'processed'
    ORDER BY effective_at DESC
    LIMIT 1
  `;
  return row?.school_id && row.student_id
    ? { schoolId: row.school_id, studentId: row.student_id }
    : null;
}

async function applyStoreEvent(
  database: Database | DatabasePools,
  event: StoreBillingEvent,
  logger: Logger,
  requestId?: string,
): Promise<string> {
  const result = await withSystemTx(database, (tx) =>
    processBillingEvent(tx, event, {
      emitAudit: auditWriter,
      publishEntitlementChange,
      logger,
      requestId,
    }),
  );
  return result.outcome;
}

async function verify(
  store: StoreBilling,
  platform: StorePlatform,
  verificationData: string,
  locale: SupportedLocale,
): Promise<StoreSubscription> {
  const client = platform === "apple" ? store.apple : store.google;
  if (!client) throw storeError(503, ERROR_CODES.STORE_BILLING_NOT_CONFIGURED, locale);
  try {
    return platform === "apple"
      ? await store.apple!.verifyTransaction(verificationData)
      : await store.google!.getSubscription(verificationData);
  } catch (error) {
    if (error instanceof StoreVerificationError) {
      throw storeError(400, ERROR_CODES.STORE_PURCHASE_INVALID, locale);
    }
    throw error;
  }
}

/**
 * Record a purchase the signed-in student's app completed, and turn their AI add-on on.
 *
 * The purchase must be for the configured product, still active, stamped by the app with this
 * student's id (so a receipt cannot be replayed onto another account), and not already registered
 * to a different student. Re-registering the same purchase -- a retry, or "restore purchases" --
 * is idempotent.
 */
export async function registerStorePurchase(
  database: Database | DatabasePools,
  store: StoreBilling,
  logger: Logger,
  params: {
    schoolId: string;
    userId: string;
    requestId?: string;
    platform: StorePlatform;
    verificationData: string;
    locale: SupportedLocale;
  },
): Promise<StorePurchaseResult> {
  const { locale } = params;
  const [student] = await withTenantTx(
    database,
    { schoolId: params.schoolId, userId: params.userId, requestId: params.requestId },
    (tx) => tx<{ id: string }[]>`
      SELECT id FROM app.students WHERE user_id = ${params.userId}::uuid LIMIT 1
    `,
  );
  if (!student) throw storeError(403, ERROR_CODES.STORE_PURCHASE_ACCOUNT_MISMATCH, locale);

  const subscription = await verify(store, params.platform, params.verificationData, locale);
  if (subscription.productId !== store.productId) {
    throw storeError(400, ERROR_CODES.STORE_PURCHASE_INVALID, locale);
  }
  if (subscription.studentId !== student.id.toLowerCase()) {
    throw storeError(403, ERROR_CODES.STORE_PURCHASE_ACCOUNT_MISMATCH, locale);
  }
  if (subscription.state === "expired" || subscription.state === "revoked") {
    throw storeError(409, ERROR_CODES.STORE_PURCHASE_NOT_ACTIVE, locale);
  }

  const claim = await withSystemTx(database, (tx) =>
    findClaim(tx, subscription.platform, subscription.storeRef),
  );
  if (claim && claim.studentId !== student.id) {
    throw storeError(409, ERROR_CODES.STORE_PURCHASE_ALREADY_CLAIMED, locale);
  }

  await applyStoreEvent(
    database,
    storeBillingEvent({
      eventId: `${subscription.platform}:purchase:${subscription.transactionId}`,
      kind: "purchased",
      subscription,
      schoolId: params.schoolId,
      studentId: student.id,
      effectiveAt: subscription.periodStart,
    }),
    logger,
    params.requestId,
  );

  if (subscription.platform === "google") {
    // Play refunds a purchase left unacknowledged for three days. Acknowledging only after the
    // purchase is recorded means a failure here is retried by the app's next report, never lost.
    try {
      await store.google!.acknowledge(subscription.productId, subscription.storeRef);
    } catch (error) {
      logger.warn({ err: error }, "google play acknowledge failed; the next report retries it");
    }
  }

  return { active: true, expiresAt: subscription.periodEnd?.toISOString() ?? null };
}

async function applyNotification(
  database: Database | DatabasePools,
  logger: Logger,
  params: {
    eventId: string;
    kind: StoreEventKind | null;
    subscription: StoreSubscription | null;
    effectiveAt: Date;
  },
): Promise<"ignored" | "unattributed" | string> {
  const { kind, subscription } = params;
  if (!kind || !subscription) return "ignored";

  const claim = await withSystemTx(database, (tx) =>
    findClaim(tx, subscription.platform, subscription.storeRef),
  );
  // A purchase the app has not reported yet (it reports on completion, so this is the window
  // before that, or an app that crashed) is attributed by what the purchase itself carries -- on
  // Google both ids, on Apple only the student, which is not enough to find the school. Unattributed
  // notifications are dropped: the app's report creates the record, and the store resends.
  const schoolId = claim?.schoolId ?? subscription.schoolId;
  const studentId = claim?.studentId ?? subscription.studentId;
  if (!schoolId || !studentId) {
    logger.info(
      { platform: subscription.platform, event_id: params.eventId },
      "store notification for a purchase not yet registered; skipped",
    );
    return "unattributed";
  }

  return applyStoreEvent(
    database,
    storeBillingEvent({
      eventId: `${subscription.platform}:notification:${params.eventId}`,
      kind,
      subscription,
      schoolId,
      studentId,
      effectiveAt: params.effectiveAt,
    }),
    logger,
  );
}

/** App Store Server Notifications V2. Throws CodedHttpException(400) when the signature fails. */
export async function handleAppleNotification(
  database: Database | DatabasePools,
  store: StoreBilling,
  logger: Logger,
  signedPayload: string,
): Promise<string> {
  if (!store.apple) throw storeError(503, ERROR_CODES.STORE_BILLING_NOT_CONFIGURED, "en");
  let notification;
  try {
    notification = await store.apple.verifyNotification(signedPayload);
  } catch (error) {
    if (error instanceof StoreVerificationError) {
      throw storeError(400, ERROR_CODES.STORE_WEBHOOK_INVALID, "en");
    }
    throw error;
  }
  return applyNotification(database, logger, {
    eventId: notification.eventId,
    kind: notification.kind,
    subscription: notification.subscription,
    effectiveAt: notification.signedAt,
  });
}

/** Google Play RTDN through a Pub/Sub push. The caller has already checked the URL token. */
export async function handleGooglePlayNotification(
  database: Database | DatabasePools,
  store: StoreBilling,
  logger: Logger,
  body: unknown,
): Promise<string> {
  if (!store.google) throw storeError(503, ERROR_CODES.STORE_BILLING_NOT_CONFIGURED, "en");
  let notification;
  try {
    notification = store.google.parseNotification(body);
  } catch (error) {
    if (error instanceof StoreVerificationError) {
      throw storeError(400, ERROR_CODES.STORE_WEBHOOK_INVALID, "en");
    }
    throw error;
  }
  if (!notification.kind || !notification.purchaseToken) return "ignored";

  const subscription = await store.google.getSubscription(notification.purchaseToken);
  return applyNotification(database, logger, {
    eventId: notification.eventId,
    kind: notification.kind,
    subscription,
    effectiveAt: notification.sentAt,
  });
}
