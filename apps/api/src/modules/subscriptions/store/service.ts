import { createHash } from "node:crypto";

import { processBillingEvent } from "@studafy/billing";
import { DOMAIN_EVENTS, ERROR_CODES, LEGAL_DOCUMENT_VERSIONS } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { withSystemTx, withTenantTx } from "../../../db/tenant-tx";
import { emit } from "../../../lib/events";
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
 *   for, so it is also where that link is recorded (as the purchase's billing event), and where the
 *   student's waiver of the 14-day right of withdrawal is recorded and confirmed
 *   ({@link recordWithdrawalWaiver}).
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

/**
 * The student's express request, made in the app before the store's purchase sheet opened, for the
 * AI add-on to start straight away, and their acknowledgement that they lose the 14-day right of
 * withdrawal once it does (Directive 2011/83/EU art. 16(m); Terms of Service 7.7).
 */
export interface StoreWithdrawalWaiver {
  /** When the student ticked the box, by the device's clock. */
  acknowledgedAt: Date;
}

/** How the waiver was confirmed to the student on a durable medium. */
export type WithdrawalWaiverConfirmation = "email" | "in_app";

/** What the app shows of a recorded waiver: the in-app copy of the confirmation. */
export interface StorePurchaseConfirmation {
  acknowledgedAt: string;
  recordedAt: string;
  termsVersion: string;
  confirmation: WithdrawalWaiverConfirmation;
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
    /**
     * The waiver the app sent with the purchase. Absent from app versions that do not ask for it,
     * from "restore purchases", and from a purchase redelivered after the app lost it: recorded as
     * nothing, never refused, because by now the store has taken the money.
     */
    withdrawalWaiver?: StoreWithdrawalWaiver | null;
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

  await recordWithdrawalWaiver(database, logger, {
    schoolId: params.schoolId,
    userId: params.userId,
    requestId: params.requestId,
    studentId: student.id,
    subscription,
    waiver: params.withdrawalWaiver ?? null,
  });

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

/**
 * Which store purchase a waiver belongs to: the platform and the SHA-256 of the transaction id. The
 * transaction, not the subscription's stable reference: an Apple resubscription keeps its
 * originalTransactionId but is a new contract with a new right of withdrawal. Hashed because Google
 * falls back to the purchase token -- a credential for the purchase -- when Play reports no order
 * id, and app.ai_subscriptions is readable at tenant level (000195).
 */
function waiverPurchaseRef(subscription: StoreSubscription): string {
  const digest = createHash("sha256").update(subscription.transactionId).digest("hex");
  return `${subscription.platform}:${digest}`;
}

const deliverableEmail = z.string().email();

/**
 * Record the student's withdrawal waiver on their AI add-on row, and confirm it to them on a durable
 * medium: an email when the account has a deliverable address, otherwise the copy the app shows
 * from the store config (`purchaseConfirmation`) -- a member-ID student has no email (000141).
 *
 * Once per purchase: a report of a purchase whose waiver is already recorded (a retry) changes
 * nothing and sends nothing. A report without a waiver -- "restore purchases", or an app version
 * that does not ask -- records nothing, and leaves an earlier purchase's waiver in place: it is still
 * true, and says which purchase it was for. The audit log keeps every one recorded.
 */
async function recordWithdrawalWaiver(
  database: Database | DatabasePools,
  logger: Logger,
  params: {
    schoolId: string;
    userId: string;
    requestId?: string;
    studentId: string;
    subscription: StoreSubscription;
    waiver: StoreWithdrawalWaiver | null;
  },
): Promise<void> {
  const { waiver } = params;
  if (!waiver) return;
  const purchaseRef = waiverPurchaseRef(params.subscription);
  await withTenantTx(
    database,
    { schoolId: params.schoolId, userId: params.userId, requestId: params.requestId },
    async (tx) => {
      const [row] = await tx<{ id: string; purchase_ref: string | null }[]>`
        SELECT id, withdrawal_waiver_purchase_ref AS purchase_ref
        FROM app.ai_subscriptions
        WHERE student_id = ${params.studentId}::uuid
        FOR UPDATE
      `;
      if (!row) {
        logger.warn(
          { student_id: params.studentId, platform: params.subscription.platform },
          "store purchase registered without an AI add-on row; withdrawal waiver not recorded",
        );
        return;
      }
      if (row.purchase_ref === purchaseRef) return;

      const [user] = await tx<{ email: string | null }[]>`
        SELECT email FROM app.users WHERE id = ${params.userId}::uuid
      `;
      const email = deliverableEmail.safeParse(user?.email ?? null);
      const confirmation: WithdrawalWaiverConfirmation = email.success ? "email" : "in_app";
      const termsVersion = LEGAL_DOCUMENT_VERSIONS.terms;

      // The device's clock, but never later than the server's: the waiver cannot postdate the
      // purchase it was given for.
      const [recorded] = await tx<{ acknowledged_at: Date; recorded_at: Date }[]>`
        UPDATE app.ai_subscriptions
           SET withdrawal_waiver_purchase_ref = ${purchaseRef},
               withdrawal_waiver_acknowledged_at =
                 LEAST(${waiver.acknowledgedAt}::timestamptz, CURRENT_TIMESTAMP),
               withdrawal_waiver_terms_version = ${termsVersion},
               withdrawal_waiver_recorded_at = CURRENT_TIMESTAMP,
               withdrawal_waiver_confirmation = ${confirmation}
         WHERE id = ${row.id}::uuid
        RETURNING withdrawal_waiver_acknowledged_at AS acknowledged_at,
                  withdrawal_waiver_recorded_at AS recorded_at
      `;
      const acknowledgedAt = recorded!.acknowledged_at.toISOString();
      const recordedAt = recorded!.recorded_at.toISOString();

      await emitAuditLog(tx, {
        action: "update",
        targetTable: "ai_subscriptions",
        targetId: row.id,
        oldValues: { withdrawal_waiver_purchase_ref: row.purchase_ref },
        newValues: {
          withdrawal_waiver_purchase_ref: purchaseRef,
          withdrawal_waiver_acknowledged_at: acknowledgedAt,
          withdrawal_waiver_terms_version: termsVersion,
          withdrawal_waiver_recorded_at: recordedAt,
          withdrawal_waiver_confirmation: confirmation,
        },
      });

      if (email.success) {
        await emit(tx, DOMAIN_EVENTS.AI_STORE_PURCHASE_CONFIRMED, {
          schoolId: params.schoolId,
          aiSubscriptionId: row.id,
          studentId: params.studentId,
          email: email.data,
          platform: params.subscription.platform,
          acknowledgedAt,
          recordedAt,
          termsVersion,
        });
      }
    },
  );
}

/** The signed-in student's recorded withdrawal waiver, for the app's in-app confirmation. */
export async function readStorePurchaseConfirmation(
  tx: TransactionSql,
  studentId: string,
): Promise<StorePurchaseConfirmation | null> {
  const [row] = await tx<
    {
      acknowledged_at: Date | null;
      recorded_at: Date | null;
      terms_version: string | null;
      confirmation: WithdrawalWaiverConfirmation | null;
    }[]
  >`
    SELECT withdrawal_waiver_acknowledged_at AS acknowledged_at,
           withdrawal_waiver_recorded_at AS recorded_at,
           withdrawal_waiver_terms_version AS terms_version,
           withdrawal_waiver_confirmation AS confirmation
    FROM app.ai_subscriptions
    WHERE student_id = ${studentId}::uuid
  `;
  if (!row?.acknowledged_at || !row.recorded_at || !row.terms_version || !row.confirmation) {
    return null;
  }
  return {
    acknowledgedAt: row.acknowledged_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    termsVersion: row.terms_version,
    confirmation: row.confirmation,
  };
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
  if (notification.otherPackage) {
    // Another app's RTDN topic points at this endpoint: Play Console needs fixing, not the payload.
    logger.warn(
      { package: notification.otherPackage, eventId: notification.eventId },
      "google play notification for another package ignored",
    );
    return "ignored";
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
